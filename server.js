const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(express.json());

// CONFIGURATION
const PAYSTACK_SECRET_KEY = "sk_test_c3b230d3d9658476cc9f71e72697ba1a41f28c7b";

// DATABASE LEDGERS (In Production, persistent via MongoDB)
const players = {}; 
const adminLedger = { totalCommission: 0 };
const activeGames = {};

// 1. GET LIST OF NIGERIAN BANKS (FOR WITHDRAWAL FORM)
app.get('/api/banks', async (req, res) => {
    try {
        const response = await axios.get('https://api.paystack.co/bank', {
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
        });
        res.json({ status: true, banks: response.data.data });
    } catch (error) {
        res.status(500).json({ status: false, message: "Could not fetch banks" });
    }
});

// 2. INITIALIZE DEPOSIT
app.post('/api/deposit', async (req, res) => {
    const { email, amount, userId } = req.body;
    try {
        const response = await axios.post('https://api.paystack.co/transaction/initialize', {
            email: email,
            amount: amount * 100, // Naira to Kobo
            metadata: { userId: userId, custom_fields: [{ display_name: "User ID", variable_name: "user_id", value: userId }] }
        }, {
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
        });
        res.json({ status: true, authorization_url: response.data.data.authorization_url });
    } catch (error) {
        res.status(500).json({ status: false, message: "Deposit initialization failed" });
    }
});

// 3. AUTOMATIC PAYSTACK WEBHOOK (CREDIT USER WALLET ON PAYMENT)
app.post('/api/paystack-webhook', (req, res) => {
    const event = req.body;
    if (event.event === 'charge.success') {
        const userId = event.data.metadata.userId;
        const amountPaid = event.data.amount / 100; // Kobo to Naira
        
        if (!players[userId]) players[userId] = { balance: 0 };
        players[userId].balance += amountPaid;

        // Emit updated balance if user is online
        io.to(userId).emit('balance_update', { balance: players[userId].balance });
    }
    res.sendStatus(200);
});

// 4. PROCESS PLAYER WITHDRAWAL (AUTOMATED BANK TRANSFER)
app.post('/api/withdraw', async (req, res) => {
    const { userId, amount, bankCode, accountNumber } = req.body;
    
    if (!players[userId] || players[userId].balance < amount) {
        return res.status(400).json({ status: false, message: "Insufficient balance for withdrawal." });
    }

    try {
        // Step A: Create Transfer Recipient
        const recipientRes = await axios.post('https://api.paystack.co/transferrecipient', {
            type: "nuban",
            name: `Player_${userId}`,
            account_number: accountNumber,
            bank_code: bankCode,
            currency: "NGN"
        }, {
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
        });

        const recipientCode = recipientRes.data.data.recipient_code;

        // Step B: Initiate Transfer
        const transferRes = await axios.post('https://api.paystack.co/transfer', {
            source: "balance",
            amount: amount * 100,
            recipient: recipientCode,
            reason: "Nairawhot Wallet Withdrawal"
        }, {
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
        });

        // Deduct balance on successful initiation
        players[userId].balance -= amount;
        res.json({ status: true, message: "Withdrawal successful! Processing to your bank." });
    } catch (error) {
        res.status(500).json({ status: false, message: error.response?.data?.message || "Transfer failed." });
    }
});

// SOCKET MULTIPLAYER & GAME ENGINE
io.on('connection', (socket) => {
    socket.on('register_user', (data) => {
        const { userId } = data;
        socket.userId = userId;
        socket.join(userId);
        if (!players[userId]) players[userId] = { balance: 1000 }; // Test balance
        socket.emit('balance_update', { balance: players[userId].balance });
    });

    socket.on('find_match', (data) => {
        const { userId, stake } = data;
        const balance = players[userId] ? players[userId].balance : 0;

        if (balance < stake) {
            return socket.emit('error_message', 'Insufficient wallet balance. Please deposit.');
        }

        // Matchmaking queue execution
        if (app.locals.waitingPlayer && app.locals.waitingPlayer.userId !== userId && app.locals.waitingPlayer.stake === stake) {
            const opponent = app.locals.waitingPlayer;
            const roomId = `room_${opponent.userId}_${userId}`;

            socket.join(roomId);
            opponent.socket.join(roomId);

            // Deduct Stakes
            players[opponent.userId].balance -= stake;
            players[userId].balance -= stake;

            // Financial Split: 20% House Commission, 80% Winner Prize
            const totalPot = stake * 2;
            const houseCommission = totalPot * 0.20;
            const winnerPrize = totalPot - houseCommission;

            adminLedger.totalCommission += houseCommission;

            // Notify balances
            io.to(opponent.userId).emit('balance_update', { balance: players[opponent.userId].balance });
            io.to(userId).emit('balance_update', { balance: players[userId].balance });

            io.to(roomId).emit('match_started', {
                roomId: roomId,
                players: [opponent.userId, userId],
                winnerPrize: winnerPrize,
                houseCommission: houseCommission
            });

            app.locals.waitingPlayer = null;
        } else {
            app.locals.waitingPlayer = { socket: socket, userId: userId, stake: stake };
            socket.emit('waiting_for_opponent', 'Searching for a live player...');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Nairawhot Backend live on port ${PORT}`));
            
