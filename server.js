const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(express.json());

// Your Paystack Secret Key
const PAYSTACK_SECRET_KEY = "sk_test_c3b230d3d9658476cc9f71e72697ba1a41f28c7b";

// In-Memory Balance Storage & Admin Commission Ledger
const players = {}; 
const adminWallet = { totalCommission: 0 };
let waitingPlayer = null;

// Paystack Deposit Endpoint
app.post('/api/deposit', async (req, res) => {
    const { email, amount, userId } = req.body;
    try {
        const response = await axios.post('https://api.paystack.co/transaction/initialize', {
            email: email,
            amount: amount * 100, // Converts Naira to Kobo for Paystack
            callback_url: "https://nairawhot.onrender.com/api/paystack-callback"
        }, {
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
        });

        res.json({ status: true, authorization_url: response.data.data.authorization_url });
    } catch (error) {
        res.status(500).json({ status: false, message: "Payment initialization failed" });
    }
});

// Callback after Paystack deposit
app.get('/api/paystack-callback', async (req, res) => {
    const { reference, userId, amount } = req.query;
    if (userId) {
        if (!players[userId]) players[userId] = { balance: 0 };
        players[userId].balance += parseFloat(amount || 0);
    }
    res.send("<h2>Deposit Successful! Please return to your Nairawhot app.</h2>");
});

// Socket.io Real-Time Matchmaking & 20% House Cut Logic
io.on('connection', (socket) => {
    socket.on('register_user', (data) => {
        const { userId } = data;
        if (!players[userId]) players[userId] = { balance: 1000 }; // Gives ₦1,000 starting test bonus
        socket.userId = userId;
        socket.emit('balance_update', { balance: players[userId].balance });
    });

    socket.on('find_match', (data) => {
        const { userId, stake } = data;
        const userBalance = players[userId] ? players[userId].balance : 0;

        if (userBalance < stake) {
            return socket.emit('error_message', 'Insufficient balance. Please deposit funds.');
        }

        if (waitingPlayer && waitingPlayer.userId !== userId && waitingPlayer.stake === stake) {
            const room = `room_${waitingPlayer.userId}_${userId}`;
            socket.join(room);
            waitingPlayer.socket.join(room);

            // Deduct stake amounts from both players
            players[waitingPlayer.userId].balance -= stake;
            players[userId].balance -= stake;

            const totalPot = stake * 2;
            const houseCut = totalPot * 0.20; // Your 20% platform commission
            const winnerPrize = totalPot - houseCut;

            adminWallet.totalCommission += houseCut;

            io.to(room).emit('match_started', {
                room: room,
                totalPot: totalPot,
                winnerPrize: winnerPrize,
                houseCut: houseCut
            });

            waitingPlayer = null;
        } else {
            waitingPlayer = { socket: socket, userId: userId, stake: stake };
            socket.emit('waiting_for_opponent', 'Searching for a live player...');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Nairawhot Backend running on port ${PORT}`));
