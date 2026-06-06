const app = require('./api/index');

const PORT = process.env.PORT || 3000;

// Chỉ listen khi chạy cục bộ ở môi trường phát triển (không chạy trên Vercel)
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`=============================================================`);
    console.log(`Ứng dụng tải video Tivi Sony đang chạy cục bộ tại:`);
    console.log(`👉 http://localhost:${PORT}`);
    console.log(`Mở trình duyệt trên máy tính của bạn và truy cập link trên!`);
    console.log(`=============================================================`);
  });
}
