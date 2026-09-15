const { default: makeWASocket, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { supabase } = require('./supabase');
const { useSupabaseAuthState } = require('./supabaseAuth');
const { io } = require('./server'); // Import io for real-time updates

let sock;
let connectionState = 'disconnected'; // 'connected', 'disconnected', 'connecting'
let currentQr = null;
let activeGroupJids = [];

async function startWhatsApp() {
    const sessionId = process.env.SESSION_ID || 'default';
    const { state, saveCreds } = await useSupabaseAuthState(supabase, sessionId);
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }), // Hide noisy logs
        browser: ['GroupDesk', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            currentQr = qr;
            console.log('QR Code generated. Scan to login.');
            io.emit('qr-code', qr);
        }

        if (connection === 'connecting') {
            connectionState = 'connecting';
            io.emit('wa-status', 'connecting');
        } else if (connection === 'close') {
            const isConflict = lastDisconnect.error?.output?.statusCode === 440 || lastDisconnect.error?.message?.includes('conflict');
            
            if (isConflict) {
                connectionState = 'conflict';
                io.emit('wa-status', 'conflict');
                console.log('🚨 WhatsApp Conflict: Another instance is running! Not reconnecting automatically to prevent infinite loop.');
                return; // Stop the loop
            }

            connectionState = 'disconnected';
            currentQr = null;
            activeGroupJids = [];
            const shouldReconnect = (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut);
            console.log('Connection closed due to', lastDisconnect.error, ', reconnecting:', shouldReconnect);
            io.emit('wa-status', 'disconnected');
            if (shouldReconnect) {
                console.log('⏳ Reconnecting in 5 seconds to prevent rate limits...');
                setTimeout(() => {
                    startWhatsApp();
                }, 5000);
            } else {
                // If logged out, delete auth state from Supabase
                const sessionId = process.env.SESSION_ID || 'default';
                await supabase.from('auth_state').delete().eq('session_id', sessionId);
                
                // Disable all groups to prevent cross-sim ghost groups in UI
                await supabase.from('groups').update({ enabled: false }).neq('id', '0');
                io.emit('groups-updated');
                
                console.log('Logged out. Deleted auth info from Supabase and disabled all groups.');
            }
        } else if (connection === 'open') {
            connectionState = 'connected';
            console.log('✅ WhatsApp Connected!');
            io.emit('wa-status', 'connected');
            syncGroups();
        }
    });

    // Handle Historical Sync
    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest }) => {
        console.log(`Syncing ${messages.length} historical messages...`);
        const messagesToInsert = [];
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;
            
            const jid = msg.key.remoteJid;
            if (!jid.endsWith('@g.us')) continue; // Only handle groups
            
            const participantJid = msg.key.participant || jid;
            const pushName = msg.pushName || 'User'; 
            
            let senderDisplay = pushName;
            
            let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            let type = 'text';

            if (msg.message.imageMessage) { type = 'image'; text = msg.message.imageMessage.caption || text; }
            else if (msg.message.videoMessage) { type = 'video'; text = msg.message.videoMessage.caption || text; }
            else if (msg.message.documentMessage) { type = 'document'; text = msg.message.documentMessage.fileName || text; }
            else if (msg.message.audioMessage) { type = 'audio'; }
            
            messagesToInsert.push({
                id: msg.key.id,
                group_id: jid,
                sender_id: participantJid,
                sender_display: senderDisplay,
                kind: 'client',
                direction: 'in',
                type: type,
                text: text,
                media_url: null, 
                created_at: new Date(msg.messageTimestamp * 1000 || Date.now()).toISOString(),
                status: 'received'
            });
        }

        if (messagesToInsert.length > 0) {
            // Upsert historical messages in chunks to avoid large payload errors
            const chunkSize = 1000;
            for (let i = 0; i < messagesToInsert.length; i += chunkSize) {
                const chunk = messagesToInsert.slice(i, i + chunkSize);
                await supabase.from('messages').upsert(chunk, { onConflict: 'id', ignoreDuplicates: true });
            }
        }

        console.log('✅ Historical sync complete!');
        io.emit('groups-updated');
    });

    // Handle incoming messages
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        
        for (const msg of m.messages) {
            if (!msg.message) continue;
            
            const jid = msg.key.remoteJid;
            if (!jid.endsWith('@g.us')) continue; // Only handle groups

            // Check if group is enabled in our DB
            let { data: group } = await supabase.from('groups').select('*').eq('id', jid).single();
            if (!group) {
                // If not in DB, add it but disabled by default
                const groupMetadata = await sock.groupMetadata(jid).catch(() => null);
                const groupName = groupMetadata ? groupMetadata.subject : jid;
                const { data: newGroup } = await supabase.from('groups').insert({ 
                    id: jid, 
                    whatsapp_group_id: jid,
                    name: groupName, 
                    enabled: false 
                }).select().single();
                group = newGroup;
            }

            if (!group.enabled) continue; // Ignore disabled groups

            // Handle incoming reaction
            if (msg.message.reactionMessage) {
                const reactionMsg = msg.message.reactionMessage;
                const targetMsgId = reactionMsg.key.id;
                const reactionText = reactionMsg.text; // empty if removing reaction
                
                // Fetch target message
                const { data: targetMsg } = await supabase.from('messages').select('*').eq('id', targetMsgId).single();
                if (targetMsg) {
                    let reactions = targetMsg.reactions || {};
                    if (reactionText) {
                        reactions[reactionText] = (reactions[reactionText] || 0) + 1;
                    }
                    
                    await supabase.from('messages').update({ reactions }).eq('id', targetMsgId);
                    
                    // Emit updated message to frontend
                    const { data: updatedMsg } = await supabase.from('messages').select('*').eq('id', targetMsgId).single();
                    if (updatedMsg) {
                        const { io } = require('./server');
                        io.to(jid).emit('new-message', updatedMsg);
                    }
                }
                continue; // Skip normal message processing
            }

            // Extract sender logic
            const participantJid = msg.key.participant || jid; // Who sent it
            const pushName = msg.pushName;
            
            let senderDisplay = pushName;
            
            // If no pushName, use Alias logic (R1, R2...)
            if (!pushName) {
                let { data: aliasRecord } = await supabase.from('aliases').select('*').eq('group_id', jid).eq('participant_id', participantJid).single();
                if (!aliasRecord) {
                    const { data: counterData, error: rpcError } = await supabase.rpc('increment_anon_counter', { group_id_param: jid });
                    const newCounter = rpcError ? 1 : counterData;
                    
                    const { data: newAlias } = await supabase.from('aliases').insert({
                        group_id: jid,
                        participant_id: participantJid,
                        alias: `R${newCounter}`
                    }).select().single();
                    aliasRecord = newAlias;
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

            // Download media if exists & Upload to Supabase Storage
            if (imageMsg || videoMsg || documentMsg || audioMsg) {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', { }, { 
                        logger: pino({ level: 'silent' }),
                        reuploadRequest: sock.updateMediaMessage
                    });
                    
                    const extension = imageMsg ? '.jpg' : videoMsg ? '.mp4' : documentMsg ? ('.' + documentMsg.fileName.split('.').pop()) : '.ogg';
                    const filename = `media_${msg.key.id}_${Date.now()}${extension}`;
                    
                    // Upload to Supabase storage bucket 'uploads'
                    const { data, error } = await supabase.storage.from('uploads').upload(filename, buffer, {
                        contentType: imageMsg ? 'image/jpeg' : videoMsg ? 'video/mp4' : documentMsg ? 'application/octet-stream' : 'audio/ogg'
                    });

                    if (!error) {
                        const { data: publicUrlData } = supabase.storage.from('uploads').getPublicUrl(filename);
                        mediaUrl = publicUrlData.publicUrl;
                    } else {
                        console.error('Supabase storage upload error:', error);
                    }
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

            // Save to DB (only if it doesn't exist, preventing double-emit for tool-sent messages)
            const isFromMe = msg.key.fromMe;
            const msgDirection = isFromMe ? 'out' : 'in';
            const msgStatus = isFromMe ? 'sent' : 'received';
            const actualSenderId = isFromMe ? (sock.user.id.split(':')[0] + '@s.whatsapp.net') : participantJid;
            const actualSenderDisplay = isFromMe ? 'You' : senderDisplay;

            const msgTimestamp = new Date(msg.messageTimestamp * 1000 || Date.now()).toISOString();

            const { data: newMessage, error } = await supabase.from('messages').upsert({
                id: msg.key.id,
                group_id: jid,
                sender_id: actualSenderId,
                sender_display: actualSenderDisplay,
                kind: 'client',
                direction: msgDirection,
                type: type,
                text: text,
                media_url: mediaUrl,
                status: msgStatus,
                quoted_msg: quotedMsg,
                created_at: msgTimestamp
            }, { onConflict: 'id', ignoreDuplicates: true }).select().maybeSingle();

            if (error) console.error('Error saving message:', error);

            if (newMessage) {
                // Update group last active
                await supabase.from('groups').update({ 
                    last_at: new Date().toISOString(), 
                    last_preview: text || type 
                }).eq('id', jid);
                
                if (!isFromMe) {
                    await supabase.rpc('increment_unread', { group_id_param: jid });
                }

                // Emit to frontend
                io.to(jid).emit('new-message', newMessage);
                io.emit('groups-updated');
            }
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
            const { data: existing } = await supabase.from('groups').select('id').eq('id', jid).single();
            if (!existing) {
                await supabase.from('groups').insert({ 
                    id: jid, 
                    whatsapp_group_id: jid,
                    name: group.subject, 
                    enabled: false 
                });
            } else {
                await supabase.from('groups').update({ name: group.subject }).eq('id', jid);
            }
        }
        io.emit('groups-updated');
        console.log('✅ Groups synced to Supabase');
    } catch (e) {
        console.error('Error syncing groups', e);
    }
}

// Function to send message from Frontend -> WhatsApp
async function sendMessage(groupId, text, type = 'text', mediaUrl = null, quotedMsgId = null) {
    if (!sock) throw new Error('WhatsApp not connected');

    const options = {};
    let quotedMsgObj = null;
    
    if (quotedMsgId) {
        const { data: quotedMsg } = await supabase.from('messages').select('*').eq('id', quotedMsgId).single();
        if (quotedMsg) {
            quotedMsgObj = {
                id: quotedMsg.id,
                sender: quotedMsg.sender_display,
                text: quotedMsg.text
            };
            options.quoted = {
                key: {
                    id: quotedMsg.id,
                    remoteJid: groupId,
                    fromMe: quotedMsg.direction === 'out',
                    participant: quotedMsg.direction === 'in' ? quotedMsg.sender_id : sock.user.id.split(':')[0] + '@s.whatsapp.net'
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
        // Fetch buffer from Supabase public URL
        const response = await fetch(mediaUrl);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        const fileName = mediaUrl.split('/').pop();
        if (type === 'image') sentMsg = await sock.sendMessage(groupId, { image: buffer, caption: text }, options);
        if (type === 'video') sentMsg = await sock.sendMessage(groupId, { video: buffer, caption: text }, options);
        if (type === 'audio') sentMsg = await sock.sendMessage(groupId, { audio: buffer, ptt: true }, options);
        if (type === 'document') sentMsg = await sock.sendMessage(groupId, { document: buffer, caption: text, fileName: fileName }, options);
    }

    if (sentMsg) {
        // Save outgoing message to DB
        const { data: newMessage, error } = await supabase.from('messages').insert({
            id: sentMsg.key.id,
            group_id: groupId,
            sender_id: sock.user.id.split(':')[0] + '@s.whatsapp.net',
            sender_display: 'You',
            kind: 'client',
            direction: 'out',
            type,
            text,
            media_url: mediaUrl,
            status: 'sent',
            quoted_msg: quotedMsgObj
        }).select().single();
        
        await supabase.from('groups').update({ last_at: new Date().toISOString(), last_preview: text || type }).eq('id', groupId);
        io.to(groupId).emit('new-message', newMessage);
        io.emit('groups-updated');
        
        return newMessage;
    }
    throw new Error('Failed to send');
}

async function logoutWhatsApp() {
    if (sock) {
        try { await sock.logout(); } catch(e) {}
        connectionState = 'disconnected';
        activeGroupJids = [];
        io.emit('wa-status', 'disconnected');
    }
    
    // Ensure all groups are disabled on explicit logout
    await supabase.from('auth_state').delete().eq('session_id', 'default');
    await supabase.from('groups').update({ enabled: false }).neq('id', '0');
    io.emit('groups-updated');
}

async function forceGenerateQr() {
    console.log('Force regenerating QR...');
    if (sock) {
        try {
            sock.ev.removeAllListeners();
            sock.ws.close();
        } catch(e) {}
    }
    // Delete existing auth info from DB
    await supabase.from('auth_state').delete().eq('session_id', 'default');
    
    // Disable all groups to prevent cross-sim ghost groups
    await supabase.from('groups').update({ enabled: false }).neq('id', '0');
    io.emit('groups-updated');
    
    currentQr = null;
    await startWhatsApp();
}

module.exports = { startWhatsApp, syncGroups, sendMessage, logoutWhatsApp, forceGenerateQr, getStatus: () => connectionState, getQr: () => currentQr, getActiveGroupJids: () => activeGroupJids, getSock: () => sock };
