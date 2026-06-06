const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Conditional require to prevent errors if yt-dlp binary is not supported in the running environment
let ytDlp;
try {
  ytDlp = require('yt-dlp-exec');
} catch (e) {
  console.warn('Cảnh báo: Không thể tải yt-dlp-exec. Sẽ sử dụng ytdl-core làm dự phòng.');
}

const ytdl = require('@distube/ytdl-core');

const app = express();

app.use(cors());
app.use(express.json());

// Tự động phục vụ file tĩnh nếu chạy cục bộ (trên Vercel thì Vercel tự động host thư mục public)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Xác định thư mục downloads tạm thời (sử dụng /tmp nếu chạy trên Vercel)
const isVercel = process.env.VERCEL || process.env.NODE_ENV === 'production';
const downloadsDir = isVercel
  ? path.join('/tmp', 'downloads')
  : path.join(__dirname, '..', 'downloads');

if (!isVercel) {
  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
  } else {
    // Dọn dẹp file tạm cũ khi chạy cục bộ
    try {
      const files = fs.readdirSync(downloadsDir);
      for (const file of files) {
        fs.unlinkSync(path.join(downloadsDir, file));
      }
      console.log('Đã dọn dẹp các file tạm cũ trong thư mục downloads cục bộ.');
    } catch (err) {
      console.error('Không thể dọn dẹp thư mục downloads:', err);
    }
  }
}

// Helper: Làm sạch tên file để tương thích hệ thống file Windows và Tivi Sony
function sanitizeFilename(filename) {
  return filename.replace(/[\\/:*?"<>|]/g, '_').trim();
}

// 1. API lấy thông tin video (Hỗ trợ cả Local và Vercel)
app.get('/api/info', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ success: false, message: 'Thiếu đường dẫn YouTube!' });
  }

  // Chế độ Vercel: Sử dụng ytdl-core để lấy thông tin (không cần binary, nhanh, không lỗi 500)
  if (isVercel) {
    try {
      console.log(`[Vercel] Đang lấy thông tin video: ${videoUrl}`);
      const info = await ytdl.getBasicInfo(videoUrl);
      
      const thumbnail = info.videoDetails.thumbnails && info.videoDetails.thumbnails.length
        ? info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1].url
        : '';

      return res.json({
        success: true,
        data: {
          title: info.videoDetails.title,
          thumbnail: thumbnail,
          duration: parseInt(info.videoDetails.lengthSeconds) || 0,
          uploader: info.videoDetails.author.name,
          isVercel: true
        }
      });
    } catch (error) {
      console.error('[Vercel] Lỗi lấy thông tin video:', error.message);
      return res.status(500).json({ success: false, message: 'Không thể phân tích video này trên Vercel. Vui lòng kiểm tra lại đường dẫn YouTube.' });
    }
  }

  // Chế độ Local: Sử dụng yt-dlp
  try {
    console.log(`[Local] Đang lấy thông tin video: ${videoUrl}`);
    if (!ytDlp) throw new Error('yt-dlp-exec không khả dụng');
    
    const info = await ytDlp(videoUrl, {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
      noCheckCertificate: true,
      preferFreeFormats: true,
      youtubeSkipDashManifest: true
    });

    res.json({
      success: true,
      data: {
        title: info.title,
        thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails.length ? info.thumbnails[info.thumbnails.length - 1].url : ''),
        duration: info.duration,
        uploader: info.uploader,
        isVercel: false
      }
    });
  } catch (error) {
    console.error('[Local] Lỗi khi lấy thông tin video:', error.message);
    res.status(500).json({ success: false, message: 'Không thể phân tích video này. Hãy chắc chắn đường dẫn chính xác.' });
  }
});

// 2. API theo dõi tiến trình tải video qua Server-Sent Events (SSE)
app.get('/api/download-progress', (req, res) => {
  const { url, quality } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Thiếu đường dẫn video' });
  }

  // Thiết lập SSE Headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // Chế độ Vercel: Không dùng file tạm, gửi link stream trực tiếp về client để tải qua browser
  if (isVercel) {
    console.log(`[Vercel] Yêu cầu tải video. Gửi link stream trực tiếp.`);
    
    // Gửi ngay trạng thái hoàn thành kèm link stream trực tiếp
    // Link stream sẽ gọi qua endpoint `/api/stream` để proxy video từ YouTube về client không bị lỗi CORS
    const streamUrl = `/api/stream?url=${encodeURIComponent(url)}&quality=${encodeURIComponent(quality)}`;
    
    res.write(`data: ${JSON.stringify({ status: 'completed', filename: 'direct_stream', directUrl: streamUrl })}\n\n`);
    res.end();
    return;
  }

  // Chế độ Local: Sử dụng yt-dlp tải về ổ đĩa rồi gửi file
  const tempFilename = `download_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp4`;
  const outputPath = path.join(downloadsDir, tempFilename);
  const formatOption = quality === '360p' ? '18' : 'best[ext=mp4]/best';

  console.log(`[Local] Bắt đầu tải video. Format: ${formatOption}, Output: ${outputPath}`);

  if (!ytDlp) {
    res.write(`data: ${JSON.stringify({ status: 'error', message: 'Hệ thống thiếu công cụ tải yt-dlp.' })}\n\n`);
    res.end();
    return;
  }

  const subprocess = ytDlp.exec(url, {
    output: outputPath,
    format: formatOption,
    noPlaylist: true,
    noWarnings: true
  });

  subprocess.stdout.on('data', (data) => {
    const output = data.toString();
    const match = output.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    if (match) {
      const percent = parseFloat(match[1]);
      res.write(`data: ${JSON.stringify({ status: 'downloading', percent })}\n\n`);
    }

    if (output.includes('[Merger]') || output.includes('[VideoConvertor]') || output.includes('[ffmpeg]')) {
      res.write(`data: ${JSON.stringify({ status: 'converting' })}\n\n`);
    }
  });

  subprocess.stderr.on('data', (data) => {
    console.error(`yt-dlp stderr: ${data.toString()}`);
  });

  subprocess.on('close', (code) => {
    if (code === 0 && fs.existsSync(outputPath)) {
      console.log(`Tải thành công video tạm: ${tempFilename}`);
      res.write(`data: ${JSON.stringify({ status: 'completed', filename: tempFilename })}\n\n`);
    } else {
      console.error(`yt-dlp thất bại với mã lỗi: ${code}`);
      res.write(`data: ${JSON.stringify({ status: 'error', message: 'Tải video thất bại từ phía YouTube. Vui lòng thử lại!' })}\n\n`);
    }
    res.end();
  });

  req.on('close', () => {
    if (subprocess) {
      subprocess.kill();
    }
    setTimeout(() => {
      if (fs.existsSync(outputPath)) {
        try { fs.unlinkSync(outputPath); } catch (e) {}
      }
    }, 1000);
  });
});

// 3. API tải file thực tế về máy khách (Chỉ dùng ở Local)
app.get('/api/download-file', (req, res) => {
  const { filename, title } = req.query;

  if (!filename) {
    return res.status(400).send('Thiếu tên file');
  }

  const filePath = path.join(downloadsDir, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Không tìm thấy file video hoặc file đã bị xóa.');
  }

  const displayTitle = title ? sanitizeFilename(title) : 'video';
  const downloadName = `${displayTitle}.mp4`;

  console.log(`Đang gửi file cho người dùng: ${downloadName}`);

  res.download(filePath, downloadName, (err) => {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (unlinkErr) {
      console.error('Không thể xóa file tạm:', unlinkErr);
    }
  });
});

// 4. API Proxy Stream Video (Chỉ dùng trên Vercel hoặc dự phòng)
app.get('/api/stream', async (req, res) => {
  const { url, quality, title } = req.query;
  if (!url) {
    return res.status(400).send('Thiếu đường dẫn YouTube!');
  }

  try {
    const displayTitle = title ? sanitizeFilename(title) : 'video';
    
    // Gửi headers báo tải file MP4 về trình duyệt
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(displayTitle)}.mp4"`);
    res.setHeader('Content-Type', 'video/mp4');

    console.log(`[Stream Proxy] Khởi tạo stream cho URL: ${url}, chất lượng: ${quality}`);

    // Chọn định dạng MP4 có sẵn cả hình và tiếng
    // itag 18: MP4 360p (luôn có sẵn audio + video)
    // itag 22: MP4 720p (thường có sẵn audio + video trên hầu hết video)
    const itagOption = quality === '360p' ? 18 : 22;

    const stream = ytdl(url, {
      quality: itagOption,
      filter: format => format.container === 'mp4' && format.hasAudio && format.hasVideo
    });

    stream.on('error', (err) => {
      console.error('[Stream Proxy] Lỗi stream:', err.message);
      if (!res.headersSent) {
        res.status(500).send('Lỗi khi truyền tải video từ YouTube.');
      }
    });

    stream.pipe(res);
  } catch (error) {
    console.error('[Stream Proxy] Lỗi API stream:', error.message);
    if (!res.headersSent) {
      res.status(500).send('Có lỗi xảy ra khi proxy video.');
    }
  }
});

// Xuất app Express để Vercel Serverless Function sử dụng
module.exports = app;
