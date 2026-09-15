const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const { supabase } = require('./supabase');
const { initCron } = require('./cron');

// Production Environment Checks
if (!process.env.SUPABASE_URL || !process.env.DATABASE_URL) {
    console.error('🚨 CRITICAL ERROR: Missing SUPABASE_URL or DATABASE_URL in .env file.');
    process.exit(1);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Static files (Frontend)
app.use(express.static(path.join(__dirname, '../frontend')));
app.use(express.json());
app.use(cors());

// Socket.io connection handling
io.on('connection', (socket) => {
    socket.on('join-group', (groupId) => {
        // Leave previous rooms
        Array.from(socket.rooms).forEach(room => {
            if (room !== socket.id) socket.leave(room);
        });
        socket.join(groupId);
    });
});

// File upload setup - Memory Storage for Supabase
const storage = multer.memoryStorage();
const upload = multer({ storage });

// API Routes
app.get('/api/groups', async (req, res) => {
    try {
        const { getStatus, getActiveGroupJids } = require('./whatsapp');
        
        const { data: groups, error } = await supabase.from('groups').select('*').order('last_at', { ascending: false, nullsFirst: false });
        if (error) throw error;
        
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

app.post('/api/groups/:groupId/read', async (req, res) => {
    try {
        const { error } = await supabase.from('groups').update({ unread: 0 }).eq('id', req.params.groupId);
        if (error) throw error;
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/messages/:groupId', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        const after = req.query.after;
        
        let query = supabase
            .from('messages')
            .select('*')
            .eq('group_id', req.params.groupId)
            .order('created_at', { ascending: false });
            
        if (after) {
            // Delta sync: fetch everything newer than the last timestamp
            // We still order descending so we can just reverse it later like normal
            query = query.gt('created_at', after);
        } else {
            // Standard pagination
            query = query.range(offset, offset + limit - 1);
        }
            
        const { data: messages, error } = await query;
            
        if (error) throw error;
        
        // Reverse because UI expects oldest first (bottom up)
        res.json(messages.reverse());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    try {
        const ext = path.extname(req.file.originalname);
        const filename = `media_${crypto.randomUUID()}${ext}`;
        
        const { data, error } = await supabase.storage.from('uploads').upload(filename, req.file.buffer, {
            contentType: req.file.mimetype
        });
        
        if (error) throw error;
        
        const { data: publicUrlData } = supabase.storage.from('uploads').getPublicUrl(filename);
        
        res.json({ url: publicUrlData.publicUrl, filename: filename, type: req.file.mimetype });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/messages/react', async (req, res) => {
    try {
        const { groupId, messageId, reaction } = req.body;
        const { getSock } = require('./whatsapp');
        const sock = getSock();
        if (!sock) return res.status(400).json({ error: 'Not connected' });
        
        const { data: msg } = await supabase.from('messages').select('*').eq('id', messageId).single();
        if (!msg) return res.status(404).json({ error: 'Message not found' });
        
        await sock.sendMessage(groupId, {
            react: {
                text: reaction,
                key: { 
                    id: messageId, 
                    remoteJid: groupId, 
                    fromMe: msg.direction === 'out',
                    participant: msg.direction === 'in' ? msg.sender_id : undefined
                }
            }
        });
        
        // Update DB
        const reactions = msg.reactions || {};
        reactions[reaction] = (reactions[reaction] || 0) + 1;
        
        await supabase.from('messages').update({ reactions }).eq('id', messageId);
        
        const { data: updatedMsg } = await supabase.from('messages').select('*').eq('id', messageId).single();
        io.to(groupId).emit('new-message', updatedMsg);
        io.to(groupId).emit('reaction-updated', { messageId, reaction });
        
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// Helper to get Admin PIN
async function getAdminPin() {
    const { data } = await supabase.from('app_settings').select('admin_pin').eq('id', 1).single();
    return data?.admin_pin || '1234';
}

app.post('/api/admin/verify', async (req, res) => {
    const { pin } = req.body;
    const currentPin = await getAdminPin();
    if (pin === currentPin) {
        res.json({ valid: true });
    } else {
        res.status(401).json({ valid: false, error: 'Invalid PIN' });
    }
});

app.post('/api/admin/toggle-group', async (req, res) => {
    const { pin, groupId, enabled } = req.body;
    const currentPin = await getAdminPin();
    if (pin !== currentPin) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const { data: group, error } = await supabase
            .from('groups')
            .update({ enabled })
            .eq('id', groupId)
            .select()
            .single();
            
        if (error) throw error;
        
        io.emit('groups-updated');
        res.json(group);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// App Settings APIs
app.post('/api/admin/settings', async (req, res) => {
    const { pin, auto_delete_enabled, auto_delete_days, new_admin_pin } = req.body;
    const currentPin = await getAdminPin();
    if (pin !== currentPin) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const updateData = { id: 1, auto_delete_enabled, auto_delete_days };
        if (new_admin_pin) {
            updateData.admin_pin = new_admin_pin;
        }
        
        const { data: settings, error } = await supabase
            .from('app_settings')
            .upsert(updateData)
            .select()
            .single();
            
        if (error) throw error;
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/settings', async (req, res) => {
    try {
        const { data: settings, error } = await supabase
            .from('app_settings')
            .select('*')
            .eq('id', 1)
            .single();
            
        if (error) throw error;
        res.json(settings || { auto_delete_enabled: false, auto_delete_days: 60 });
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

// Start the cron job
initCron();
