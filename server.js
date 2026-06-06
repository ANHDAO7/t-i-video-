const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const ytDlp = require('yt-dlp-exec');

const app = express();
const PORT = process.env.PORT || 3000;

// Cấu hình Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Tạo thư mục downloads tạm nếu chưa có
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
} else {
  // Dọn dẹp các file tạm cũ khi khởi động server
  try {
    const files = fs.readdirSync(downloadsDir);
    for (const file of files) {
      fs.unlinkSync(path.join(downloadsDir, file));
    }
    console.log('Đã dọn dẹp các file tạm cũ trong thư mục downloads.');
  } catch (err) {
    console.error('Không thể dọn dẹp thư mục downloads:', err);
  }
}

// Helper: Làm sạch tên file để tương thích với Windows và Tivi Sony
function sanitizeFilename(filename) {
  // Loại bỏ ký tự đặc biệt nguy hiểm đối với hệ thống file Windows và Tivi Sony
  let sanitized = filename.replace(/[\\/:*?"<>|]/g, '_');
  // Chuyển các ký tự có dấu hoặc đặc biệt khác thành không dấu nếu cần (để tivi đời cực cũ đọc tốt hơn)
  // Tuy nhiên tivi Sony hiện đại đọc unicode rất tốt, chỉ cần loại bỏ ký tự hệ thống file
  return sanitized.trim();
}

// 1. API lấy thông tin video
app.get('/api/info', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ success: false, message: 'Thiếu đường dẫn YouTube!' });
  }

  try {
    console.log(`Đang lấy thông tin cho video: ${videoUrl}`);
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
        uploader: info.uploader
      }
    });
  } catch (error) {
    console.error('Lỗi khi lấy thông tin video:', error.message);
    res.status(500).json({ success: false, message: 'Không thể phân tích video này. Hãy chắc chắn đường dẫn YouTube chính xác và video không bị chặn địa lý/riêng tư.' });
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

  const tempFilename = `download_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp4`;
  const outputPath = path.join(downloadsDir, tempFilename);

  // Định dạng tải:
  // - 'best': yt-dlp sẽ tự chọn định dạng MP4 tốt nhất tích hợp sẵn âm thanh (thường là 720p hoặc cao hơn nếu có ffmpeg)
  // - '360p': format 18 (MP4 360p có sẵn âm thanh)
  const formatOption = quality === '360p' ? '18' : 'best[ext=mp4]/best';

  console.log(`Bắt đầu tải video. Format: ${formatOption}, Output: ${outputPath}`);

  // Chạy yt-dlp process
  const subprocess = ytDlp.exec(url, {
    output: outputPath,
    format: formatOption,
    noPlaylist: true,
    noWarnings: true
  });

  // Theo dõi stdout để bóc tách tiến trình %
  subprocess.stdout.on('data', (data) => {
    const output = data.toString();
    
    // Tìm phần trăm download
    const match = output.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    if (match) {
      const percent = parseFloat(match[1]);
      res.write(`data: ${JSON.stringify({ status: 'downloading', percent })}\n\n`);
    }

    // Phát hiện trạng thái đang merge/convert của ffmpeg nếu có
    if (output.includes('[Merger]') || output.includes('[VideoConvertor]') || output.includes('[ffmpeg]')) {
      res.write(`data: ${JSON.stringify({ status: 'converting' })}\n\n`);
    }
  });

  subprocess.stderr.on('data', (data) => {
    console.error(`yt-dlp stderr: ${data.toString()}`);
  });

  // Khi tải xong hoặc gặp lỗi
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

  // Nếu client hủy kết nối giữa chừng, dừng tiến trình yt-dlp và xóa file tạm
  req.on('close', () => {
    if (subprocess) {
      console.log('Client đã ngắt kết nối. Dừng tiến trình tải.');
      subprocess.kill();
    }
    setTimeout(() => {
      if (fs.existsSync(outputPath)) {
        try {
          fs.unlinkSync(outputPath);
          console.log(`Đã xóa file tạm khi client hủy: ${tempFilename}`);
        } catch (e) {
          console.error('Không thể xóa file tạm:', e);
        }
      }
    }, 1000);
  });
});

// 3. API tải file thực tế về máy khách và xóa file tạm sau đó
app.get('/api/download-file', (req, res) => {
  const { filename, title } = req.query;

  if (!filename) {
    return res.status(400).send('Thiếu tên file');
  }

  const filePath = path.join(downloadsDir, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Không tìm thấy file video. Có thể file đã bị xóa hoặc hết hạn.');
  }

  // Tạo tên file tải về sạch sẽ và tương thích tốt
  const displayTitle = title ? sanitizeFilename(title) : 'video';
  const downloadName = `${displayTitle}.mp4`;

  console.log(`Đang gửi file cho người dùng: ${downloadName}`);

  res.download(filePath, downloadName, (err) => {
    if (err) {
      console.error('Lỗi khi gửi file cho client:', err);
    }

    // Xóa file tạm ngay lập tức sau khi gửi xong (hoặc thất bại) để tiết kiệm dung lượng đĩa
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Đã dọn dẹp file tạm thành công: ${filename}`);
      }
    } catch (unlinkErr) {
      console.error('Không thể xóa file tạm sau download:', unlinkErr);
    }
  });
});

// Chạy server
app.listen(PORT, () => {
  console.log(`=============================================================`);
  console.log(`Ứng dụng tải video Tivi Sony đang chạy tại:`);
  console.log(`👉 http://localhost:${PORT}`);
  console.log(`Mở trình duyệt trên máy tính của bạn và truy cập link trên!`);
  console.log(`=============================================================`);
});
