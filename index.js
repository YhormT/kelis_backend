require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const createUserRouter = require('./routes/userRoutes');
const authRoutes = require('./routes/authRoutes');
const cartRoutes = require('./routes/cartRoutes');
const productRoutes = require('./routes/productRoutes');
const orderRoutes = require('./routes/orderRoutes');
const topUpRoutes = require('./routes/topUpRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const salesRoutes = require('./routes/salesRoutes');
const smsRoutes = require('./routes/smsRoutes');
const announcementRoutes = require('./routes/announcementRoutes');
const pasteRoutes = require('./routes/pasteRoutes');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Be more specific in production
    methods: ["GET", "POST"]
  }
});

const userSockets = new Map();

io.on('connection', (socket) => {
  console.log('a user connected', socket.id);

  socket.on('register', (userId) => {
    console.log(`Registering user ${userId} with socket ${socket.id}`);
    userSockets.set(userId, socket.id);
  });

  socket.on('disconnect', () => {
    console.log('user disconnected', socket.id);
    for (let [userId, socketId] of userSockets.entries()) {
      if (socketId === socket.id) {
        userSockets.delete(userId);
        break;
      }
    }
  });
});

// Export io and userSockets for use in other modules
module.exports = { app, io, userSockets };

app.use(express.json());
app.use(cors());
app.use(helmet());

const userRoutes = createUserRouter(io, userSockets);
app.use('/api/users', userRoutes);



app.use('/api/order', pasteRoutes);
app.use('/api/auth', authRoutes);
app.use('/cart', cartRoutes);
app.use('/products', productRoutes);
app.use('/order', orderRoutes);
app.use('/api', topUpRoutes);
app.use('/api', uploadRoutes);
app.use('/api', transactionRoutes);

app.use('/api/sales', salesRoutes);
app.use('/api/sms', smsRoutes);
app.use('/api/announcement', announcementRoutes);
app.use('/api', pasteRoutes);


const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
