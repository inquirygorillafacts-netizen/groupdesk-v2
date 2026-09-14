// Global variables
const socket = io();
let activeGroupId = null;
let currentPin = '';
let groups = [];
let pendingFile = null;

document.addEventListener('DOMContentLoaded', () => {
    fetchWaStatus(); // Check and sync header status immediately
    fetchGroups();
    
    const msgInput = document.getElementById('message-input');
    
    // Emoji Picker Setup (wrapped in try-catch so it doesn't crash the whole app if CDN fails)
    try {
        if (window.picmoPopup && window.picmo) {
            const { createPopup } = window.picmoPopup;
            const emojiBtn = document.getElementById('emoji-btn');
            const picker = createPopup({}, {
                referenceElement: emojiBtn,
                triggerElement: emojiBtn,
                position: 'top-start'
            });

            emojiBtn.addEventListener('click', () => {
                picker.toggle();
            });

            picker.addEventListener('emoji:select', (event) => {
                msgInput.value += event.emoji;
            });
        }
    } catch (e) {
        console.error('Emoji picker failed to load:', e);
    }

    // Send Message
    const sendBtn = document.getElementById('send-btn');
    if (sendBtn) sendBtn.addEventListener('click', sendMessage);
    
    if (msgInput) {
        msgInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                sendMessage();
            }
        });
    }

    // File Input Setup
    const fileInput = document.getElementById('file-input');
    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                pendingFile = e.target.files[0];
                showMediaPreview(pendingFile);
            }
        });
    }
});

// Socket Events
let waConnected = false;

socket.on('wa-status', (status) => {
    const el = document.getElementById('connection-status');
    const wasConnected = waConnected;
    waConnected = (status === 'connected');
    
    if (waConnected) {
        el.innerHTML = '<i data-lucide="circle" class="w-2 h-2 text-emerald-400 fill-emerald-400"></i> Connected';
        // Trigger surprise animation if it just connected
        if (!wasConnected) {
            confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
        }
    } else {
        el.innerHTML = '<i data-lucide="circle" class="w-2 h-2 text-amber-300 fill-amber-300"></i> Disconnected';
    }
    lucide.createIcons();
    updateQrUi();
});

socket.on('groups-updated', () => {
    fetchGroups();
});

socket.on('new-message', (msg) => {
    if (msg.groupId === activeGroupId) {
        appendMessage(msg);
        scrollToBottom();
    }
});

socket.on('qr-code', (qrDataUrl) => {
    if (waConnected) return; // Ignore if connected
    const qrContainer = document.getElementById('qr-container');
    qrContainer.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(qrDataUrl)}" class="w-full h-full rounded-lg shadow-sm" />`;
});

function updateQrUi(initialQr = null) {
    const qrContainer = document.getElementById('content-qr');
    if (!qrContainer) return;
    
    if (waConnected) {
        qrContainer.innerHTML = `
            <div class="flex flex-col items-center justify-center p-6 bg-emerald-50 rounded-lg border border-emerald-100 text-center">
                <div class="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mb-4">
                    <i data-lucide="check-circle" class="w-8 h-8"></i>
                </div>
                <h3 class="text-lg font-bold text-emerald-800 mb-1">Successfully Connected!</h3>
                <p class="text-sm text-emerald-600 mb-6">GroupDesk is syncing and listening to your WhatsApp.</p>
                <button onclick="disconnectWhatsApp()" class="px-4 py-2 bg-red-500 text-white rounded-md hover:bg-red-600 shadow-sm flex items-center gap-2">
                    <i data-lucide="log-out" class="w-4 h-4"></i> Disconnect
                </button>
            </div>
        `;
        lucide.createIcons();
    } else {
        if (initialQr) {
            qrContainer.innerHTML = `
                <p class="text-sm text-slate-500 mb-4">Scan the QR code with WhatsApp to connect.</p>
                <div id="qr-container" class="w-48 h-48 bg-white shadow-sm border mx-auto rounded-lg flex items-center justify-center p-2">
                    <img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(initialQr)}" class="w-full h-full rounded-md" />
                </div>
            `;
        } else {
            qrContainer.innerHTML = `
                <div class="flex flex-col items-center justify-center p-6 text-center">
                    <div class="w-16 h-16 bg-slate-100 text-slate-400 rounded-full flex items-center justify-center mb-4">
                        <i data-lucide="smartphone" class="w-8 h-8"></i>
                    </div>
                    <h3 class="text-lg font-bold text-slate-700 mb-1">Not Connected</h3>
                    <p class="text-sm text-slate-500 mb-6">You need to link your WhatsApp to continue.</p>
                    <button id="generate-qr-btn" onclick="generateQr()" class="px-4 py-2 bg-brand-primary text-white rounded-md hover:bg-emerald-600 shadow-sm flex items-center gap-2">
                        <i data-lucide="qr-code" class="w-4 h-4"></i> Generate QR
                    </button>
                    <p id="qr-loading-text" class="text-sm text-slate-400 mt-4 hidden">Please wait...</p>
                </div>
            `;
            lucide.createIcons();
        }
    }
}

async function generateQr() {
    const btn = document.getElementById('generate-qr-btn');
    if (btn) btn.classList.add('hidden');
    const loading = document.getElementById('qr-loading-text');
    if (loading) loading.classList.remove('hidden');

    try {
        await fetch('/api/whatsapp/generate-qr', { method: 'POST' });
        // The server will emit 'qr-code' socket event which will render it
    } catch (e) {
        console.error('Failed to generate QR', e);
        if (loading) loading.innerText = 'Error generating QR. Please retry.';
    }
}

async function fetchWaStatus() {
    const btn = document.getElementById('generate-qr-btn');
    if (btn) btn.classList.add('hidden');
    const loading = document.getElementById('qr-loading-text');
    if (loading) loading.classList.remove('hidden');

    const res = await fetch('/api/whatsapp/status');
    const data = await res.json();
    waConnected = data.connected;
    
    // Sync header status UI
    const el = document.getElementById('connection-status');
    if (el) {
        if (waConnected) {
            el.innerHTML = '<i data-lucide="circle" class="w-2 h-2 text-emerald-400 fill-emerald-400"></i> Connected';
        } else {
            el.innerHTML = '<i data-lucide="circle" class="w-2 h-2 text-amber-300 fill-amber-300"></i> Disconnected';
        }
        lucide.createIcons();
    }
    
    // If not connected but no QR is ready yet, we will just show loading 
    // and wait for socket.on('qr-code')
    if (!data.connected && !data.qr) {
        updateQrUi();
        const loadingAg = document.getElementById('qr-loading-text');
        if (loadingAg) loadingAg.classList.remove('hidden');
        if (document.getElementById('generate-qr-btn')) document.getElementById('generate-qr-btn').classList.add('hidden');
        return;
    }
    
    updateQrUi(data.qr);
}

async function forceSyncGroups(event) {
    const btn = event.currentTarget;
    const icon = btn.querySelector('i');
    if (icon) icon.classList.add('animate-spin');
    try {
        await fetch('/api/whatsapp/sync-groups', { method: 'POST' });
        // The server will emit 'groups-updated' which triggers fetchGroups()
    } catch (e) {
        console.error('Failed to sync groups', e);
    }
    setTimeout(() => { if (icon) icon.classList.remove('animate-spin'); }, 1000);
}

async function disconnectWhatsApp() {
    if (!confirm('Are you sure you want to disconnect WhatsApp?')) return;
    await fetch('/api/whatsapp/logout', { method: 'POST' });
    waConnected = false;
    updateQrUi();
}

async function fetchGroups() {
    const res = await fetch('/api/groups');
    groups = await res.json();
    renderSidebar();
    renderAdminGroups();
}

function renderSidebar() {
    const list = document.getElementById('groups-list');
    list.innerHTML = '';
    
    const visible = groups.filter(g => g.enabled);
    if (visible.length === 0) {
        list.innerHTML = '<div class="p-6 text-sm text-slate-500 text-center">No groups enabled by Admin yet.</div>';
        return;
    }

    visible.forEach(g => {
        const div = document.createElement('div');
        const isActive = g.id === activeGroupId;
        div.className = `w-full text-left px-3 py-3 flex items-start gap-3 hover:bg-slate-50 border-b border-slate-100 transition cursor-pointer ${isActive ? 'bg-emerald-50/60' : ''}`;
        div.onclick = () => selectGroup(g);
        
        const time = new Date(g.lastAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        div.innerHTML = `
            <div class="w-10 h-10 rounded-full bg-gradient-to-br from-brand-primary to-brand-deep text-white flex items-center justify-center font-semibold shrink-0">${g.name.slice(0,1)}</div>
            <div class="flex-1 min-w-0">
                <div class="flex justify-between items-center">
                    <div class="font-medium text-[14px] truncate">${g.name}</div>
                    <div class="text-[10px] text-slate-400 ml-2">${time}</div>
                </div>
                <div class="flex justify-between items-center mt-0.5">
                    <div class="text-[12px] text-slate-500 truncate">${g.lastPreview || 'No messages'}</div>
                    ${g.unread > 0 ? `<span class="px-1.5 py-0.5 rounded-full bg-brand-primary text-white text-[10px]">${g.unread}</span>` : ''}
                </div>
            </div>
        `;
        list.appendChild(div);
    });
}

async function selectGroup(group) {
    activeGroupId = group.id;
    socket.emit('join-group', group.id);
    
    document.getElementById('active-group-header').classList.remove('hidden');
    document.getElementById('chat-input-area').classList.remove('hidden');
    document.getElementById('active-group-name').innerText = group.name;
    document.getElementById('active-group-anon').innerText = `Anonymized · ${group.anonCounter} unknown participants`;
    
    renderSidebar(); // Update active state
    
    const res = await fetch(`/api/messages/${encodeURIComponent(group.id)}`);
    const messages = await res.json();
    
    const chatBox = document.getElementById('chat-messages');
    chatBox.innerHTML = '';
    chatBox.className = 'flex-1 overflow-y-auto p-4 flex flex-col gap-2 chat-bg thin-scroll';
    
    messages.forEach(appendMessage);
    setTimeout(scrollToBottom, 100);
}

function appendMessage(msg) {
    const chatBox = document.getElementById('chat-messages');
    const isOut = msg.direction === 'out';
    const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    const wrapper = document.createElement('div');
    wrapper.className = `flex ${isOut ? 'justify-end' : 'justify-start'} w-full group`;
    
    // Tag Chip
    let tagHtml = '';
    if (isOut) {
        tagHtml = `<span class="text-[11px] font-medium text-white/90">You</span>`;
    } else {
        const isAlias = msg.senderDisplay.startsWith('R');
        tagHtml = isAlias 
            ? `<span class="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-emerald-100 text-emerald-800">🔒 ${msg.senderDisplay}</span>`
            : `<span class="text-[11px] font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">👤 ${msg.senderDisplay}</span>`;
    }

    // Media HTML
    let mediaHtml = '';
    if (msg.mediaUrl) {
        if (msg.type === 'image') {
            mediaHtml = `<img src="${msg.mediaUrl}" onclick="openFullscreen('${msg.mediaUrl}', 'image')" class="rounded-lg max-h-64 object-cover cursor-pointer my-1 w-full" />`;
        } else if (msg.type === 'video') {
            mediaHtml = `
            <div class="relative group my-1 cursor-pointer bg-black/10 rounded-lg overflow-hidden flex items-center justify-center max-h-64" onclick="openFullscreen('${msg.mediaUrl}', 'video')">
                <video src="${msg.mediaUrl}#t=0.001" preload="metadata" class="w-full h-full object-cover max-h-64 pointer-events-none"></video>
                <div class="absolute inset-0 flex items-center justify-center pointer-events-none bg-black/20 group-hover:bg-black/30 transition-colors">
                    <div class="w-12 h-12 bg-black/60 rounded-full flex items-center justify-center backdrop-blur-md">
                        <i data-lucide="play" class="w-5 h-5 text-white ml-1"></i>
                    </div>
                </div>
            </div>`;
        } else if (msg.type === 'audio') {
            mediaHtml = `<audio src="${msg.mediaUrl}" controls class="w-full max-w-[260px] h-10 my-1"></audio>`;
        } else {
            mediaHtml = `
            <a href="${msg.mediaUrl}" download class="flex items-center gap-3 p-3 rounded-xl border transition-colors max-w-sm my-1 ${isOut ? 'bg-white/10 border-white/20 text-white' : 'bg-slate-50 border-slate-200 text-slate-700'}">
                <div class="w-10 h-10 shrink-0 rounded-lg flex items-center justify-center ${isOut ? 'bg-white/20' : 'bg-emerald-100 text-emerald-600'}">
                    <i data-lucide="file-text" class="w-5 h-5"></i>
                </div>
                <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium truncate">${msg.text || 'Document'}</div>
                </div>
            </a>`;
        }
    }

    // Quoted Msg HTML
    let quotedHtml = '';
    if (msg.quotedMsg) {
        quotedHtml = `
            <div class="mb-2 rounded-lg overflow-hidden border-l-4 px-2 py-1 text-[12px] ${isOut ? 'bg-emerald-700/50 border-white/50 text-white/90' : 'bg-slate-100 border-emerald-500 text-slate-700'}">
                <div class="font-semibold text-[10px] mb-0.5 opacity-80">${msg.quotedMsg.sender || 'Unknown'}</div>
                <div class="truncate">${msg.quotedMsg.text || 'Media'}</div>
            </div>
        `;
    }

    const textHtml = (msg.text && msg.type !== 'document') ? `<div class="text-[14px] leading-snug whitespace-pre-wrap break-words mt-1">${msg.text}</div>` : '';

    // Hover actions
    const hoverHtml = `
        <div class="absolute ${isOut ? '-left-[84px]' : '-right-[84px] flex-row-reverse'} top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onclick='setReply(${JSON.stringify(msg).replace(/'/g, "&#39;")})' class="p-1.5 rounded-full bg-white border shadow-sm hover:bg-slate-50 transition-colors" title="Reply">
                <i data-lucide="reply" class="w-3.5 h-3.5 text-slate-600"></i>
            </button>
            ${msg.text ? `<button onclick="navigator.clipboard.writeText('${msg.text.replace(/'/g, "\\'")}'); alert('Copied')" class="p-1.5 rounded-full bg-white border shadow-sm hover:bg-slate-50 transition-colors" title="Copy"><i data-lucide="copy" class="w-3.5 h-3.5 text-slate-600"></i></button>` : ''}
            
            <div class="relative group/react inline-block">
                <button class="p-1.5 rounded-full bg-white border shadow-sm hover:bg-slate-50 transition-colors" title="React">
                    <i data-lucide="smile" class="w-3.5 h-3.5 text-slate-600"></i>
                </button>
                <div class="hidden group-hover/react:flex absolute bottom-full pb-1 ${isOut ? 'right-0' : 'left-0'} z-50">
                    <div class="bg-white border shadow-lg rounded-full px-2 py-1 flex items-center gap-1">
                        <button onclick="reactToMsg('${msg.id}', '👍')" class="hover:scale-125 transition-transform text-base">👍</button>
                        <button onclick="reactToMsg('${msg.id}', '❤️')" class="hover:scale-125 transition-transform text-base">❤️</button>
                        <button onclick="reactToMsg('${msg.id}', '😂')" class="hover:scale-125 transition-transform text-base">😂</button>
                        <button onclick="reactToMsg('${msg.id}', '😮')" class="hover:scale-125 transition-transform text-base">😮</button>
                        <button onclick="reactToMsg('${msg.id}', '😢')" class="hover:scale-125 transition-transform text-base">😢</button>
                        <button onclick="reactToMsg('${msg.id}', '🙏')" class="hover:scale-125 transition-transform text-base">🙏</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    // Reactions HTML
    let reactionsHtml = '';
    if (msg.reactions && Object.keys(msg.reactions).length > 0) {
        const reacts = Object.values(msg.reactions).join(' ');
        reactionsHtml = `<div class="absolute -bottom-3 ${isOut ? 'right-2' : 'left-2'} bg-white border shadow-sm rounded-full px-1.5 py-0.5 flex items-center gap-1 text-[11px] z-10">${reacts}</div>`;
    }

    // Wrap in an id to allow replacing
    wrapper.id = 'msg-node-' + msg.id;

    wrapper.innerHTML = `
        <div class="relative max-w-[70%] rounded-2xl px-3 py-2 bubble-anim shadow-sm border msg-bubble ${isOut ? 'bg-brand-primary text-white border-transparent rounded-br-md' : 'bg-white text-slate-900 border-slate-200 rounded-bl-md'}">
            <div class="flex items-center gap-2 mb-1">
                ${tagHtml}
                <span class="text-[10px] ${isOut ? 'text-white/70' : 'text-slate-400'}">${time}</span>
            </div>
            ${quotedHtml}
            ${mediaHtml}
            ${textHtml}
            ${hoverHtml}
            ${reactionsHtml}
        </div>
    `;
    
    // Replace if exists, else append
    const existing = document.getElementById('msg-node-' + msg.id);
    if (existing) {
        existing.innerHTML = wrapper.innerHTML;
    } else {
        chatBox.appendChild(wrapper);
    }
    lucide.createIcons();
}

function searchMessages(query) {
    const q = query.toLowerCase();
    const chatBox = document.getElementById('chat-messages');
    const wrappers = chatBox.querySelectorAll('.group');
    
    wrappers.forEach(wrap => {
        const textNode = wrap.querySelector('.whitespace-pre-wrap');
        const text = textNode ? textNode.innerText.toLowerCase() : '';
        
        if (!q || text.includes(q)) {
            wrap.style.display = 'flex';
            if (q && textNode) {
                // Highlight logic could go here
            }
        } else {
            wrap.style.display = 'none';
        }
    });
}

function scrollToBottom() {
    const box = document.getElementById('chat-messages');
    box.scrollTop = box.scrollHeight;
}

// Media Preview & Sending Logic
function showMediaPreview(file) {
    const container = document.getElementById('media-preview-container');
    const content = document.getElementById('media-preview-content');
    container.classList.remove('hidden');
    
    const url = URL.createObjectURL(file);
    if (file.type.startsWith('image/')) {
        content.innerHTML = `<img src="${url}" class="w-full h-full object-cover" />`;
    } else if (file.type.startsWith('video/')) {
        content.innerHTML = `<video src="${url}" class="w-full h-full object-cover"></video>`;
    } else {
        content.innerHTML = `<i data-lucide="file" class="w-10 h-10 text-slate-400"></i>`;
    }
    lucide.createIcons();
}

function closeMediaPreview() {
    document.getElementById('media-preview-container').classList.add('hidden');
    document.getElementById('file-input').value = '';
    document.getElementById('media-caption').value = '';
    pendingFile = null;
}

async function sendMessage() {
    const input = document.getElementById('message-input');
    const captionInput = document.getElementById('media-caption');
    const text = pendingFile ? captionInput.value : input.value;
    
    if ((!text.trim() && !pendingFile) || !activeGroupId) return;

    input.value = '';
    
    let type = 'text';
    let mediaUrl = null;

    if (pendingFile) {
        if (pendingFile.type.startsWith('image/')) type = 'image';
        else if (pendingFile.type.startsWith('video/')) type = 'video';
        else if (pendingFile.type.startsWith('audio/')) type = 'audio';
        else type = 'document';

        const fd = new FormData();
        fd.append('file', pendingFile);
        
        const upRes = await fetch('/api/upload', { method: 'POST', body: fd });
        const upData = await upRes.json();
        mediaUrl = upData.url;
        
        closeMediaPreview();
    }

    const payload = {
        groupId: activeGroupId,
        text: text,
        type: type,
        media: mediaUrl
    };

    if (window.replyMsg) {
        payload.quotedMsgId = window.replyMsg.id;
        clearReply();
    }

    await fetch('/api/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
}

function setReply(msg) {
    window.replyMsg = msg;
    document.getElementById('message-input').focus();
    
    // Show Preview
    const container = document.getElementById('reply-preview-container');
    if (container) {
        document.getElementById('reply-preview-sender').innerText = msg.senderDisplay || 'Unknown';
        document.getElementById('reply-preview-text').innerText = msg.text || 'Media';
        container.classList.remove('hidden');
    }
}

function clearReply() {
    window.replyMsg = null;
    document.getElementById('message-input').focus();
    
    const container = document.getElementById('reply-preview-container');
    if (container) {
        container.classList.add('hidden');
    }
}

async function reactToMsg(id, emoji) {
    if (!emoji) return;
    
    await fetch('/api/messages/react', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId: activeGroupId, messageId: id, reaction: emoji })
    });
}

// Fullscreen Viewer
function openFullscreen(url, type) {
    const viewer = document.getElementById('fullscreen-viewer');
    const content = document.getElementById('fullscreen-content');
    
    if (type === 'image') {
        content.innerHTML = `<img src="${url}" class="max-h-full max-w-full object-contain rounded-md" />`;
    } else if (type === 'video') {
        content.innerHTML = `<video src="${url}" controls autoplay class="max-h-full max-w-full outline-none rounded-md"></video>`;
    }
    viewer.classList.remove('hidden');
    viewer.classList.add('flex');
}

function closeFullscreen() {
    const viewer = document.getElementById('fullscreen-viewer');
    viewer.classList.add('hidden');
    viewer.classList.remove('flex');
    document.getElementById('fullscreen-content').innerHTML = ''; // stop video
}

// Admin Modal Logic
function openAdmin() {
    document.getElementById('admin-modal').classList.remove('hidden');
    document.getElementById('admin-modal').classList.add('flex');
    document.getElementById('admin-pin').value = '';
    document.getElementById('pin-section').classList.remove('hidden');
    document.getElementById('settings-section').classList.add('hidden');
}

function closeAdmin() {
    document.getElementById('admin-modal').classList.add('hidden');
    document.getElementById('admin-modal').classList.remove('flex');
}

async function verifyPin() {
    const pinInput = document.getElementById('admin-pin');
    const pin = pinInput.value;
    
    const res = await fetch('/api/admin/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
    });
    
    const data = await res.json();
    if (data.valid) {
        currentPin = pin;
        document.getElementById('pin-section').classList.add('hidden');
        document.getElementById('settings-section').classList.remove('hidden');
        switchTab('groups');
    } else {
        pinInput.classList.add('shake', 'border-red-500');
        setTimeout(() => pinInput.classList.remove('shake', 'border-red-500'), 400);
    }
}

function switchTab(tab) {
    document.getElementById('tab-qr').className = `pb-2 border-b-2 font-medium ${tab === 'qr' ? 'border-brand-primary text-brand-primary' : 'border-transparent text-slate-500'}`;
    document.getElementById('tab-groups').className = `pb-2 border-b-2 font-medium ${tab === 'groups' ? 'border-brand-primary text-brand-primary' : 'border-transparent text-slate-500'}`;
    
    document.getElementById('content-qr').classList.toggle('hidden', tab !== 'qr');
    document.getElementById('content-groups').classList.toggle('hidden', tab !== 'groups');
    
    if (tab === 'qr') {
        fetchWaStatus();
    }
}

function renderAdminGroups() {
    const container = document.getElementById('admin-groups-list');
    if (!container) return;
    container.innerHTML = '';
    
    groups.forEach(group => {
        const div = document.createElement('div');
        div.className = `flex items-center justify-between p-3 bg-white border border-slate-200 rounded-lg ${!group.isLive ? 'opacity-60 bg-slate-50' : ''}`;
        
        let toggleHtml = '';
        if (group.isLive) {
            toggleHtml = `
                <button onclick="toggleGroup('${group.id}', ${!group.enabled})" class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${group.enabled ? 'bg-brand-primary' : 'bg-slate-200'}">
                    <span class="pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${group.enabled ? 'translate-x-4' : 'translate-x-0'}"></span>
                </button>
            `;
        } else {
            toggleHtml = `
                <span class="text-[10px] bg-slate-200 text-slate-500 px-2 py-1 rounded font-medium border border-slate-300">Offline</span>
            `;
        }

        div.innerHTML = `
            <div class="flex items-center gap-3 min-w-0">
                <div class="w-8 h-8 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center shrink-0">
                    <i data-lucide="users" class="w-4 h-4"></i>
                </div>
                <div class="min-w-0">
                    <div class="text-sm font-semibold text-slate-700 truncate">${group.name}</div>
                    <div class="text-[10px] text-slate-400 truncate">${group.id}</div>
                </div>
            </div>
            ${toggleHtml}
        `;
        container.appendChild(div);
    });
}

async function toggleGroup(id, enabled) {
    await fetch('/api/admin/toggle-group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: currentPin, groupId: id, enabled })
    });
}
