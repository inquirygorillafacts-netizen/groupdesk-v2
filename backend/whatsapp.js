const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { Group, Message, Alias } = require('./models');
const { io } = require('./server'); // Import io for real-time updates

let sock;
let isConnected = false;
let currentQr = null;
let activeGroupJids = [];

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }), // Hide noisy logs
        browser: ['GroupDesk', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            currentQr = qr;
            console.log('QR Code generated. Scan to login.');
            io.emit('qr-code', qr);
        }

        if (connection === 'close') {
            isConnected = false;
            currentQr = null;
            activeGroupJids = [];
            const shouldReconnect = (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut);
            console.log('Connection closed due to', lastDisconnect.error, ', reconnecting:', shouldReconnect);
            io.emit('wa-status', 'disconnected');
            if (shouldReconnect) {
                startWhatsApp();
            } else {
                fs.rmSync('baileys_auth_info', { recursive: true, force: true });
                console.log('Logged out. Deleted auth info.');
            }
        } else if (connection === 'open') {
            isConnected = true;
            console.log('✅ WhatsApp Connected!');
            io.emit('wa-status', 'connected');
            syncGroups();
        }
    });

    // Handle Historical Sync
    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest }) => {
        console.log(`Syncing ${messages.length} historical messages...`);
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;
            
            const jid = msg.key.remoteJid;
            if (!jid.endsWith('@g.us')) continue; // Only handle groups
            
            // Check if msg already exists to avoid duplicates
            const existing = await Message.findOne({ id: msg.key.id });
            if (existing) continue;

            const participantJid = msg.key.participant || jid;
            const pushName = msg.pushName || 'User'; // Historical messages sometimes lack pushName
            
            let senderDisplay = pushName;
            
            let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            let type = 'text';

            if (msg.message.imageMessage) { type = 'image'; text = msg.message.imageMessage.caption || text; }
            else if (msg.message.videoMessage) { type = 'video'; text = msg.message.videoMessage.caption || text; }
            else if (msg.message.documentMessage) { type = 'document'; text = msg.message.documentMessage.fileName || text; }
            else if (msg.message.audioMessage) { type = 'audio'; }
            
            // Note: We don't download media for historical sync to save disk space and time, 
            // unless strictly requested. We'll mark mediaUrl as null for now for old media.
            
            await Message.create({
                id: msg.key.id,
                groupId: jid,
                senderId: participantJid,
                senderDisplay: senderDisplay,
                kind: 'client',
                direction: 'in',
                type: type,
                text: text,
                mediaUrl: null, 
                timestamp: msg.messageTimestamp * 1000 || Date.now(),
                status: 'received'
            });
        }
        console.log('✅ Historical sync complete!');
        io.emit('groups-updated');
    });

    // Handle incoming messages
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        
        for (const msg of m.messages) {
            if (!msg.message || msg.key.fromMe) continue;
            
            const jid = msg.key.remoteJid;
            if (!jid.endsWith('@g.us')) continue; // Only handle groups

            // Check if group is enabled in our DB
            let group = await Group.findOne({ id: jid });
            if (!group) {
                // If not in DB, add it but disabled by default
                const groupMetadata = await sock.groupMetadata(jid).catch(() => null);
                const groupName = groupMetadata ? groupMetadata.subject : jid;
                group = await Group.create({ id: jid, name: groupName, enabled: false });
            }

            if (!group.enabled) continue; // Ignore disabled groups

            // Extract sender logic
            const participantJid = msg.key.participant || jid; // Who sent it
            const pushName = msg.pushName;
            
            let senderDisplay = pushName;
            
            // If no pushName, use Alias logic (R1, R2...)
            if (!pushName) {
                let aliasRecord = await Alias.findOne({ groupId: jid, participantId: participantJid });
                if (!aliasRecord) {
                    const newCounter = (group.anonCounter || 0) + 1;
                    await Group.updateOne({ id: jid }, { $set: { anonCounter: newCounter } });
                    
                    aliasRecord = await Alias.create({
                        groupId: jid,
                        participantId: participantJid,
                        alias: `R${newCounter}`
                    });
                }
                senderDisplay = aliasRecord.alias;
            }

            // Determine message type and text
            let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            let type = 'text';
            let mediaUrl = null;

            const imageMsg = msg.message.imageMessage;
            const videoMsg = msg.message.videoMessage;
            const documentMsg = msg.message.documentMessage;
            const audioMsg = msg.message.audioMessage;

            if (imageMsg) { type = 'image'; text = imageMsg.caption || text; }
            else if (videoMsg) { type = 'video'; text = videoMsg.caption || text; }
            else if (documentMsg) { type = 'document'; text = documentMsg.fileName || text; }
            else if (audioMsg) { type = 'audio'; }

            // Download media if exists
            if (imageMsg || videoMsg || documentMsg || audioMsg) {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', { }, { 
                        logger: pino({ level: 'silent' }),
                        reuploadRequest: sock.updateMediaMessage
                    });
                    
                    const extension = imageMsg ? '.jpg' : videoMsg ? '.mp4' : documentMsg ? ('.' + documentMsg.fileName.split('.').pop()) : '.ogg';
                    const filename = `media_${Date.now()}${extension}`;
                    const uploadPath = path.join(__dirname, '../uploads');
                    if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });
                    
                    fs.writeFileSync(path.join(uploadPath, filename), buffer);
                    mediaUrl = `/uploads/${filename}`;
                } catch (e) {
                    console.error('Failed to download media:', e);
                }
            }

            // Check for quoted message
            let quotedMsg = null;
            const contextInfo = msg.message.extendedTextMessage?.contextInfo || msg.message.imageMessage?.contextInfo || msg.message.videoMessage?.contextInfo;
            if (contextInfo && contextInfo.quotedMessage) {
                quotedMsg = {
                    id: contextInfo.stanzaId,
                    text: contextInfo.quotedMessage.conversation || contextInfo.quotedMessage.extendedTextMessage?.text || '',
                    type: contextInfo.quotedMessage.imageMessage ? 'image' : 'text',
                    sender: contextInfo.participant
                };
            }

            // Save to DB
            const newMessage = await Message.create({
                id: msg.key.id,
                groupId: jid,
                senderId: participantJid,
                senderDisplay: senderDisplay,
                kind: 'client',
                direction: 'in',
                type: type,
                text: text,
                mediaUrl: mediaUrl,
                timestamp: Date.now(),
                status: 'received',
                quotedMsg: quotedMsg
            });

            // Update group last active
            await Group.updateOne({ id: jid }, { lastAt: Date.now(), lastPreview: text || type, $inc: { unread: 1 } });

            // Emit to frontend
            io.to(jid).emit('new-message', newMessage);
            io.emit('groups-updated');
        }
    });
}

// Fetch all groups from WhatsApp and save to DB
async function syncGroups() {
    if (!sock) {
        activeGroupJids = [];
        return;
    }
    try {
        const chats = await sock.groupFetchAllParticipating();
        activeGroupJids = Object.keys(chats);
        for (const jid in chats) {
            const group = chats[jid];
            const existing = await Group.findOne({ id: jid });
            if (!existing) {
                await Group.create({ id: jid, name: group.subject, enabled: false });
            } else {
                await Group.updateOne({ id: jid }, { name: group.subject });
            }
        }
        io.emit('groups-updated');
        console.log('✅ Groups synced');
    } catch (e) {
        console.error('Error syncing groups', e);
    }
}

// Function to send message from Frontend -> WhatsApp
async function sendMessage(groupId, text, type = 'text', mediaPath = null, quotedMsgId = null) {
    if (!sock) throw new Error('WhatsApp not connected');

    const options = {};
    let quotedMsgObj = null;
    
    if (quotedMsgId) {
        const { Message } = require('./models');
        const quotedMsg = await Message.findOne({ id: quotedMsgId });
        if (quotedMsg) {
            quotedMsgObj = {
                id: quotedMsg.id,
                sender: quotedMsg.senderDisplay,
                text: quotedMsg.text
            };
            options.quoted = {
                key: {
                    id: quotedMsg.id,
                    remoteJid: groupId,
                    fromMe: quotedMsg.direction === 'out',
                    participant: quotedMsg.direction === 'in' ? quotedMsg.senderId : undefined
                },
                message: {
                    conversation: quotedMsg.text || 'Media'
                }
            };
        }
    }

    let sentMsg;
    if (type === 'text') {
        sentMsg = await sock.sendMessage(groupId, { text: text }, options);
    } else if (type === 'image' || type === 'video' || type === 'audio' || type === 'document') {
        const buffer = fs.readFileSync(path.join(__dirname, '../', mediaPath));
        if (type === 'image') sentMsg = await sock.sendMessage(groupId, { image: buffer, caption: text }, options);
        if (type === 'video') sentMsg = await sock.sendMessage(groupId, { video: buffer, caption: text }, options);
        if (type === 'audio') sentMsg = await sock.sendMessage(groupId, { audio: buffer, ptt: true }, options);
        if (type === 'document') sentMsg = await sock.sendMessage(groupId, { document: buffer, caption: text, fileName: path.basename(mediaPath) }, options);
    }

    if (sentMsg) {
        // Save outgoing message to DB
        const { Message } = require('./models');
        const newMessage = await Message.create({
            id: sentMsg.key.id,
            groupId,
            senderId: sock.user.id.split(':')[0] + '@s.whatsapp.net',
            senderDisplay: 'You',
            kind: 'client',
            direction: 'out',
            type,
            text,
            mediaUrl: mediaPath,
            timestamp: Date.now(),
            status: 'sent',
            quotedMsg: quotedMsgObj
        });
        
        await Group.updateOne({ id: groupId }, { lastAt: Date.now(), lastPreview: text || type });
        io.to(groupId).emit('new-message', newMessage);
        io.emit('groups-updated');
        
        return newMessage;
    }
    throw new Error('Failed to send');
}

async function logoutWhatsApp() {
    if (sock) {
        await sock.logout();
        isConnected = false;
        activeGroupJids = [];
        io.emit('wa-status', 'disconnected');
    }
}

async function forceGenerateQr() {
    console.log('Force regenerating QR...');
    if (sock) {
        try {
            sock.ev.removeAllListeners();
            sock.ws.close();
        } catch(e) {}
    }
    // Delete existing auth info just in case to force a completely fresh login state
    try { fs.rmSync(path.join(__dirname, '../baileys_auth_info'), { recursive: true, force: true }); } catch (e) {}
    currentQr = null;
    await startWhatsApp();
}

module.exports = { startWhatsApp, syncGroups, sendMessage, logoutWhatsApp, forceGenerateQr, getStatus: () => isConnected, getQr: () => currentQr, getActiveGroupJids: () => activeGroupJids, getSock: () => sock };
