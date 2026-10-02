const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const COMMISSION_RATE = 0.20; // 20% House Fee
let adminVaultBalance = 0;

let users = {
    "player_user_1": { name: "Player 1", balance: 5000 },
    "player_user_2": { name: "Player 2", balance: 5000 }
};

let activeRooms = {};

app.get('/', (req, res) => {
    res.send('Nairawhot Live Casino Server is Running');
});

io.on('connection', (socket) => {
    console.log(`Connected: ${socket.id}`);

    socket.on('find_match', ({ userId, stake }) => {
        if (!users[userId] || users[userId].balance < stake) {
            socket.emit('error_event', 'Insufficient balance');
            return;
        }

        let roomId = `table_${stake}`;

        if (!activeRooms[roomId]) {
            activeRooms[roomId] = {
                stake: stake,
                players: [{ socketId: socket.id, userId: userId }],
                pot: 0
            };
            socket.join(roomId);
            socket.emit('waiting_for_opponent', 'Searching for a live opponent...');
        } else if (activeRooms[roomId].players.length === 1) {
            activeRooms[roomId].players.push({ socketId: socket.id, userId: userId });
            socket.join(roomId);

            const room = activeRooms[roomId];

            room.players.forEach(p => {
                users[p.userId].balance -= stake;
            });

            room.pot = stake * 2;

            io.to(roomId).emit('match_started', {
                roomId: roomId,
                pot: room.pot,
                players: room.players
            });
        }
    });

    socket.on('claim_win', ({ roomId, winnerUserId }) => {
        const room = activeRooms[roomId];
        if (!room) return;

        const totalPot = room.pot;
        const houseFee = totalPot * COMMISSION_RATE;
        const winnerEarnings = totalPot - houseFee;

        adminVaultBalance += houseFee;
        if (users[winnerUserId]) {
            users[winnerUserId].balance += winnerEarnings;
        }

        io.to(roomId).emit('game_over_result', {
            winner: winnerUserId,
            winnerAmount: winnerEarnings,
            houseFee: houseFee
        });

        delete activeRooms[roomId];
    });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
