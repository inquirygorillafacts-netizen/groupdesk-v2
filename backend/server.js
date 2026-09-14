const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const { Group, Message } = require('./models');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Static files (Frontend)
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use(express.json());
app.use(cors());

// File upload setup
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = path.join(__dirname, '../uploads');
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname.replace(/\s/g, '_'));
    }
});
const upload = multer({ storage });

// API Routes
app.get('/api/groups', async (req, res) => {
    try {
        const { getStatus, getActiveGroupJids } = require('./whatsapp');
        const groups = await Group.find({});
        const isConnected = getStatus();
        const activeJids = isConnected ? getActiveGroupJids() : [];
        
        const enrichedGroups = groups.map(g => ({
            ...g,
            isLive: activeJids.includes(g.id)
        }));
        
        res.json(enrichedGroups);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/messages/:groupId', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const messages = await Message.find({ groupId: req.params.groupId })
            .sort({ timestamp: -1 })
            .limit(limit);
        res.json(messages.reverse());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const url = `/uploads/${req.file.filename}`;
    res.json({ url, filename: req.file.filename, type: req.file.mimetype });
});

app.post('/api/messages/react', async (req, res) => {
    try {
        const { groupId, messageId, reaction } = req.body;
        const { getSock } = require('./whatsapp');
        const sock = getSock();
        if (!sock) return res.status(400).json({ error: 'Not connected' });
        
        const msg = await Message.findOne({ id: messageId });
        if (!msg) return res.status(404).json({ error: 'Message not found' });
        
        await sock.sendMessage(groupId, {
            react: {
                text: reaction,
                key: { 
                    id: messageId, 
                    remoteJid: groupId, 
                    fromMe: msg.direction === 'out',
                    participant: msg.direction === 'in' ? msg.senderId : undefined
                }
            }
        });
        
        // Update DB
        const reactions = msg.reactions || {};
        reactions[reaction] = (reactions[reaction] || 0) + 1;
        
        await Message.updateOne({ id: messageId }, { $set: { reactions } });
        
        const { io } = require('./server');
        if (io) io.to(groupId).emit('new-message', await Message.findOne({ id: messageId }));
        
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// Admin PIN Verification
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
app.post('/api/admin/verify', (req, res) => {
    const { pin } = req.body;
    if (pin === ADMIN_PIN) {
        res.json({ valid: true });
    } else {
        res.status(401).json({ valid: false, error: 'Invalid PIN' });
    }
});

app.post('/api/admin/toggle-group', async (req, res) => {
    const { pin, groupId, enabled } = req.body;
    if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const group = await Group.findOneAndUpdate({ id: groupId }, { enabled }, { new: true });
        io.emit('groups-updated');
        res.json(group);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Socket.io for Real-time communication
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    // Allow frontend to join a specific group room
    socket.on('join-group', (groupId) => {
        socket.rooms.forEach(room => {
            if (room !== socket.id) socket.leave(room);
        });
        socket.join(groupId);
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Export io so whatsapp.js can emit events
module.exports = { app, server, io };
