document.addEventListener('DOMContentLoaded', () => {
    const youtubeUrlInput = document.getElementById('youtube-url');
    const btnPaste = document.getElementById('btn-paste');
    const btnAnalyze = document.getElementById('btn-analyze');
    const errorMessage = document.getElementById('error-message');
    const resultCard = document.getElementById('result-card');
    
    const videoThumbnail = document.getElementById('video-thumbnail');
    const videoDuration = document.getElementById('video-duration');
    const videoTitle = document.getElementById('video-title');
    const videoChannel = document.querySelector('#video-channel span');
    
    const progressContainer = document.getElementById('progress-container');
    const progressBar = document.getElementById('progress-bar');
    const progressPercent = document.getElementById('progress-percent');
    const progressStatus = document.getElementById('progress-status');
    const downloadOptButtons = document.querySelectorAll('.btn-download-opt');

    let currentVideoUrl = '';
    let isAnalyzing = false;
    let isDownloading = false;

    // Paste from Clipboard
    btnPaste.addEventListener('click', async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (text) {
                youtubeUrlInput.value = text.trim();
                showError(false);
            }
        } catch (err) {
            console.error('Không thể đọc dữ liệu từ clipboard: ', err);
            alert('Không thể tự động dán. Vui lòng nhấn Ctrl+V để dán thủ công.');
        }
    });

    // Press Enter to Analyze
    youtubeUrlInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            analyzeVideo();
        }
    });

    // Click Analyze button
    btnAnalyze.addEventListener('click', analyzeVideo);

    async function analyzeVideo() {
        const url = youtubeUrlInput.value.trim();
        if (!url) {
            showError(true, 'Vui lòng nhập đường dẫn YouTube!');
            return;
        }

        if (isAnalyzing || isDownloading) return;

        isAnalyzing = true;
        btnAnalyze.classList.add('loading');
        showError(false);
        resultCard.classList.add('hidden');
        progressContainer.classList.add('hidden');

        try {
            const response = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
            const data = await response.json();

            if (!response.ok || !data.success) {
                throw new Error(data.message || 'Không thể lấy thông tin video. Vui lòng kiểm tra lại đường dẫn.');
            }

            // Display video details
            currentVideoUrl = url;
            videoThumbnail.src = data.data.thumbnail;
            videoDuration.textContent = formatDuration(data.data.duration);
            videoTitle.textContent = data.data.title;
            videoChannel.textContent = data.data.uploader;

            resultCard.classList.remove('hidden');
            resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } catch (error) {
            console.error(error);
            showError(true, error.message);
        } finally {
            isAnalyzing = false;
            btnAnalyze.classList.remove('loading');
        }
    }

    // Handle download option clicks
    downloadOptButtons.forEach(button => {
        button.addEventListener('click', () => {
            const quality = button.getAttribute('data-quality');
            if (currentVideoUrl && quality) {
                startDownloadFlow(currentVideoUrl, quality);
            }
        });
    });

    function startDownloadFlow(url, quality) {
        if (isDownloading) return;
        isDownloading = true;

        // Reset progress bar UI
        progressContainer.classList.remove('hidden');
        progressBar.style.width = '0%';
        progressPercent.textContent = '0%';
        progressStatus.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang chuẩn bị kết nối tải video...';
        
        // Disable download buttons during progress
        downloadOptButtons.forEach(btn => btn.style.pointerEvents = 'none');

        // Connect Server Sent Events
        const sseUrl = `/api/download-progress?url=${encodeURIComponent(url)}&quality=${encodeURIComponent(quality)}`;
        const eventSource = new EventSource(sseUrl);

        eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                
                if (data.status === 'downloading') {
                    const percent = data.percent || 0;
                    progressBar.style.width = `${percent}%`;
                    progressPercent.textContent = `${percent}%`;
                    progressStatus.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Đang tải về máy tính: ${percent}%`;
                } else if (data.status === 'converting') {
                    progressBar.style.width = '95%';
                    progressPercent.textContent = '95%';
                    progressStatus.innerHTML = '<i class="fas fa-cog fa-spin"></i> Đang chuyển đổi định dạng MP4 tương thích...';
                } else if (data.status === 'completed') {
                    progressBar.style.width = '100%';
                    progressPercent.textContent = '100%';
                    progressStatus.innerHTML = '<i class="fas fa-check-circle text-accent"></i> Đã tải xong! Đang lưu file về thư mục Downloads...';
                    
                    // Trigger actual file download
                    const downloadFileUrl = `/api/download-file?filename=${encodeURIComponent(data.filename)}&title=${encodeURIComponent(videoTitle.textContent)}`;
                    triggerBrowserDownload(downloadFileUrl);
                    
                    eventSource.close();
                    cleanupDownloadState();
                } else if (data.status === 'error') {
                    showError(true, data.message || 'Đã xảy ra lỗi trong quá trình tải video.');
                    eventSource.close();
                    cleanupDownloadState();
                }
            } catch (err) {
                console.error('Lỗi phân tích dữ liệu SSE:', err);
            }
        };

        eventSource.onerror = (err) => {
            console.error('Kết nối SSE bị lỗi:', err);
            showError(true, 'Kết nối với máy chủ bị gián đoạn. Vui lòng thử lại!');
            eventSource.close();
            cleanupDownloadState();
        };
    }

    function triggerBrowserDownload(url) {
        const link = document.createElement('a');
        link.href = url;
        // The server will set Content-Disposition header, but we set it just in case
        link.setAttribute('download', '');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    function cleanupDownloadState() {
        isDownloading = false;
        downloadOptButtons.forEach(btn => btn.style.pointerEvents = 'auto');
    }

    function showError(show, message = '') {
        if (show) {
            errorMessage.querySelector('.msg-text').textContent = message;
            errorMessage.classList.remove('hidden');
        } else {
            errorMessage.classList.add('hidden');
        }
    }

    // Helper: Format duration from seconds to MM:SS or HH:MM:SS
    function formatDuration(sec) {
        if (!sec || isNaN(sec)) return '00:00';
        const hours = Math.floor(sec / 3600);
        const minutes = Math.floor((sec % 3600) / 60);
        const seconds = Math.floor(sec % 60);

        const formatNum = (num) => String(num).padStart(2, '0');

        if (hours > 0) {
            return `${formatNum(hours)}:${formatNum(minutes)}:${formatNum(seconds)}`;
        }
        return `${formatNum(minutes)}:${formatNum(seconds)}`;
    }
});
