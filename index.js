require('dotenv').config();
const { server, app } = require('./backend/server');
const { startWhatsApp, sendMessage, logoutWhatsApp, getStatus, getQr, forceGenerateQr, syncGroups } = require('./backend/whatsapp');

// Additional API route for sending messages
app.post('/api/messages/send', async (req, res) => {
    try {
        const { groupId, text, type, media, quotedMsgId } = req.body;
        const msg = await sendMessage(groupId, text, type, media, quotedMsgId);
        res.json(msg);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/whatsapp/status', (req, res) => {
    res.json({ connected: getStatus(), qr: getQr() });
});

app.post('/api/whatsapp/logout', async (req, res) => {
    try {
        await logoutWhatsApp();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/whatsapp/generate-qr', async (req, res) => {
    try {
        await forceGenerateQr();
        res.json({ success: true, message: 'Generating QR...' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/whatsapp/sync-groups', async (req, res) => {
    try {
        await syncGroups();
        res.json({ success: true, message: 'Sync triggered' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3008;

server.listen(PORT, () => {
    console.log(`🚀 GroupDesk V2 Server running on http://localhost:${PORT}`);
    console.log('Starting WhatsApp Baileys connection...');
    startWhatsApp();
});
