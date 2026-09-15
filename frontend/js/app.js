// Global variables
const socket = io();
let activeGroupId = null;
let currentPin = '';
let groups = [];
let pendingFiles = [];
let currentMessageOffset = 0;
let isRecording = false;

// ==========================================
// IndexedDB for Media Drafts
// ==========================================
const dbName = 'GroupDeskDrafts';
let draftDb;
const request = indexedDB.open(dbName, 1);
request.onupgradeneeded = (e) => {
    draftDb = e.target.result;
    if (!draftDb.objectStoreNames.contains('mediaDrafts')) {
        draftDb.createObjectStore('mediaDrafts');
    }
};
request.onsuccess = (e) => draftDb = e.target.result;

async function saveMediaDraft(groupId) {
    if (!draftDb || !groupId) return;
    const tx = draftDb.transaction('mediaDrafts', 'readwrite');
    const store = tx.objectStore('mediaDrafts');
    
    if (pendingFiles.length === 0) {
        store.delete(groupId);
        return;
    }

    const filesToSave = pendingFiles.map(f => {
        return { name: f.name, type: f.type, blob: f, customCaption: f.customCaption };
    });
    
    store.put(filesToSave, groupId);
}

async function loadMediaDraft(groupId) {
    if (!draftDb || !groupId) return [];
    return new Promise((resolve) => {
        const tx = draftDb.transaction('mediaDrafts', 'readonly');
        const store = tx.objectStore('mediaDrafts');
        const req = store.get(groupId);
        req.onsuccess = () => {
            const data = req.result;
            if (data && data.length > 0) {
                const loaded = data.map(d => {
                    const f = new File([d.blob], d.name, { type: d.type });
                    f.customCaption = d.customCaption || '';
                    f.previewUrl = URL.createObjectURL(f);
                    return f;
                });
                resolve(loaded);
            } else {
                resolve([]);
            }
        };
        req.onerror = () => resolve([]);
    });
}
// ==========================================
// IndexedDB for Offline Messages Cache
// ==========================================
const msgDbName = 'GroupDeskMessages';
let msgDb;
const msgReq = indexedDB.open(msgDbName, 1);
msgReq.onupgradeneeded = (e) => {
    msgDb = e.target.result;
    if (!msgDb.objectStoreNames.contains('messages')) {
        const store = msgDb.createObjectStore('messages', { keyPath: 'id' });
        store.createIndex('group_id', 'group_id', { unique: false });
        store.createIndex('created_at', 'created_at', { unique: false });
    }
};
msgReq.onsuccess = (e) => msgDb = e.target.result;

async function saveMessagesToDb(messagesArray) {
    if (!msgDb || !messagesArray || messagesArray.length === 0) return;
    return new Promise((resolve, reject) => {
        const tx = msgDb.transaction('messages', 'readwrite');
        const store = tx.objectStore('messages');
        messagesArray.forEach(msg => store.put(msg));
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e);
    });
}

async function loadMessagesFromDb(groupId, limit = 50) {
    if (!msgDb || !groupId) return [];
    return new Promise((resolve) => {
        const tx = msgDb.transaction('messages', 'readonly');
        const store = tx.objectStore('messages');
        const index = store.index('group_id');
        const request = index.getAll(groupId);
        
        request.onsuccess = () => {
            let messages = request.result || [];
            messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
            if (messages.length > limit) {
                messages = messages.slice(messages.length - limit);
            }
            resolve(messages);
        };
        request.onerror = () => resolve([]);
    });
}
// ==========================================

let isLoadingMore = false;
let hasMoreMessages = true;
let activePreviewIndex = 0;
let searchQuery = '';
const chatCache = {}; // Client-side cache for lightning fast switching

document.addEventListener('DOMContentLoaded', () => {
    fetchWaStatus(); // Check and sync header status immediately
    fetchGroups();
    
    // Group Search Logic
    const searchInput = document.getElementById('search-groups');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            searchQuery = e.target.value.toLowerCase().trim();
            renderSidebar();
        });
    }
    
    // Clear unread if user switches back to tab while active group is open
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && activeGroupId) {
            const g = groups.find(x => x.id === activeGroupId);
            if (g && g.unread > 0) {
                g.unread = 0;
                fetch(`/api/groups/${activeGroupId}/read`, { method: 'POST' }).catch(console.error);
                renderSidebar();
            }
        }
    });
    
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
        
        // Save draft text
        msgInput.addEventListener('input', (e) => {
            if (activeGroupId) {
                localStorage.setItem(`draft_${activeGroupId}`, e.target.value);
            }
        });
    }

    const captionInput = document.getElementById('media-caption');
    if (captionInput) {
        captionInput.addEventListener('keypress', (e) => {
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
                pendingFiles = Array.from(e.target.files).map(f => {
                    f.customCaption = '';
                    f.previewUrl = URL.createObjectURL(f);
                    return f;
                });
                activePreviewIndex = 0;
                showMediaPreview();
            }
        });
    }

    const fsAddInput = document.getElementById('fs-add-file');
    if (fsAddInput) {
        fsAddInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                const newFiles = Array.from(e.target.files).map(f => {
                    f.customCaption = '';
                    f.previewUrl = URL.createObjectURL(f);
                    return f;
                });
                pendingFiles = pendingFiles.concat(newFiles);
                activePreviewIndex = pendingFiles.length - newFiles.length; // Set to first newly added file
                showMediaPreview();
            }
        });
    }

    const fsCaptionInput = document.getElementById('fs-media-caption');
    if (fsCaptionInput) {
        fsCaptionInput.addEventListener('input', (e) => {
            if (pendingFiles[activePreviewIndex]) {
                pendingFiles[activePreviewIndex].customCaption = e.target.value;
                saveMediaDraft(activeGroupId);
            }
        });
        fsCaptionInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                sendMediaFromEditor();
            }
        });
    }

    // =========================================================================
    // Drag & Drop and Paste Handlers
    // These functions allow users to paste or drag-and-drop media directly into the chat
    // =========================================================================

    // Helper function to handle new files and open the media editor
    function handleFilesAdded(fileList) {
        if (!fileList || fileList.length === 0) return;
        
        // Convert FileList to Array and attach our custom properties
        const newFiles = Array.from(fileList).map(f => {
            f.customCaption = '';
            f.previewUrl = URL.createObjectURL(f);
            return f;
        });

        // Add them to our global pendingFiles array
        pendingFiles = pendingFiles.concat(newFiles);
        saveMediaDraft(activeGroupId);
        
        // Set the active preview to the first newly added file
        activePreviewIndex = pendingFiles.length - newFiles.length;
        
        // Open the media editor
        showMediaPreview();
    }

    // 1. Paste Event Listener (on the message input box)
    const msgInputNode = document.getElementById('message-input');
    if (msgInputNode) {
        msgInputNode.addEventListener('paste', (e) => {
            // Check if there are any files in the clipboard (like copied images)
            if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
                // Prevent the default paste
                e.preventDefault(); 
                // Handle the files
                handleFilesAdded(e.clipboardData.files);
            }
            // If it's just text, do nothing and let the browser paste the text normally!
        });
    }

    // 2. Drag and Drop Event Listeners (on the entire chat area)
    const dropZone = document.getElementById('chat-messages');
    if (dropZone) {
        // We must prevent default behavior on dragover, otherwise the browser will just open the file!
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('bg-slate-50'); // Slight visual feedback
        });

        dropZone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            dropZone.classList.remove('bg-slate-50');
        });

        // Handle the actual drop
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('bg-slate-50');
            
            // Check if files were dropped
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                handleFilesAdded(e.dataTransfer.files);
            }
        });
    }
    // =========================================================================

});

// Socket Events
let waConnected = false;

socket.on('connect', () => {
    // If the socket reconnects, ensure we are still in the active group's room
    if (activeGroupId) {
        socket.emit('join-group', activeGroupId);
    }
});

socket.on('wa-status', (status) => {
    const el = document.getElementById('connection-status');
    const wasConnected = waConnected;
    waConnected = (status === 'connected');
    
    if (status === 'connected') {
        el.innerHTML = '<i data-lucide="circle" class="w-2 h-2 text-emerald-400 fill-emerald-400"></i> Connected';
        // Trigger surprise animation if it just connected
        if (!wasConnected) {
            confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
        }
    } else if (status === 'connecting') {
        el.innerHTML = '<i data-lucide="loader-2" class="w-3 h-3 text-amber-500 animate-spin"></i> Connecting...';
    } else if (status === 'conflict') {
        el.innerHTML = '<i data-lucide="alert-triangle" class="w-3 h-3 text-red-500"></i> Conflict (Multiple instances)';
    } else {
        el.innerHTML = '<i data-lucide="circle" class="w-2 h-2 text-amber-300 fill-amber-300"></i> Disconnected';
    }
    lucide.createIcons();
    
    if (status === 'connecting') {
        updateQrUi('connecting');
    } else {
        updateQrUi();
    }
});

socket.on('groups-updated', () => {
    fetchGroups();
});

socket.on('new-message', (msg) => {
    // 💾 Save immediately to local database for offline sync
    saveMessagesToDb([msg]);

    if (msg.group_id === activeGroupId && !document.hidden) {
        // If it's a message we sent, remove the oldest optimistic UI bubble instantly
        if (msg.direction === 'out' || msg.isOut) {
            const opt = document.querySelector('.optimistic-msg-node');
            if (opt) opt.remove();
        }
        
        appendMessage(msg);
        scrollToBottom();
    } else {
        // Play notification sound if message is for another group or window is hidden
        if (!msg.isOut && msg.direction !== 'out') {
            try {
                // Short minimalist blip base64 (tiny 1 second beep)
                const snd = new Audio('data:audio/mp3;base64,//NExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq');
                snd.play().catch(e => console.log('Autoplay prevented', e));
            } catch(e) {}
        }
    }
});

socket.on('reaction-updated', ({ messageId, reaction }) => {
    // Optimistic or real-time update of reaction
    // In our simplified DOM, we can just fetch messages again or update manually
    // We'll update the specific node if we can find it, otherwise rely on fetch
    fetchMessages(activeGroupId);
});

socket.on('qr-code', (qrDataUrl) => {
    if (waConnected) return; // Ignore if connected
    updateQrUi(qrDataUrl);
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
        if (initialQr === 'connecting') {
            qrContainer.innerHTML = `
                <div class="flex flex-col items-center justify-center p-6 text-center">
                    <i data-lucide="loader-2" class="w-10 h-10 text-brand-primary animate-spin mb-4"></i>
                    <h3 class="text-lg font-bold text-slate-700 mb-1">Connecting...</h3>
                    <p class="text-sm text-slate-500">GroupDesk is linking to your WhatsApp.</p>
                </div>
            `;
            lucide.createIcons();
        } else if (initialQr === 'conflict') {
            qrContainer.innerHTML = `
                <div class="flex flex-col items-center justify-center p-6 text-center bg-red-50 border border-red-100 rounded-lg">
                    <i data-lucide="alert-triangle" class="w-10 h-10 text-red-500 mb-4"></i>
                    <h3 class="text-lg font-bold text-red-800 mb-1">Conflict Error</h3>
                    <p class="text-sm text-red-600">WhatsApp is running on another server (e.g. Render). Please close one of them.</p>
                </div>
            `;
            lucide.createIcons();
        } else if (initialQr) {
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
    waConnected = (data.connected === 'connected');
    
    // Sync header status UI
    const el = document.getElementById('connection-status');
    if (el) {
        if (data.connected === 'connected') {
            el.innerHTML = '<i data-lucide="circle" class="w-2 h-2 text-emerald-400 fill-emerald-400"></i> Connected';
        } else if (data.connected === 'connecting') {
            el.innerHTML = '<i data-lucide="loader-2" class="w-3 h-3 text-amber-500 animate-spin"></i> Connecting...';
        } else if (data.connected === 'conflict') {
            el.innerHTML = '<i data-lucide="alert-triangle" class="w-3 h-3 text-red-500"></i> Conflict (Multiple instances)';
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
    const fetchedGroups = await res.json();
    
    // Auto-clear unread count for the active group if the page is visible!
    if (activeGroupId && !document.hidden) {
        const ag = fetchedGroups.find(g => g.id === activeGroupId);
        if (ag && ag.unread > 0) {
            ag.unread = 0;
            fetch(`/api/groups/${activeGroupId}/read`, { method: 'POST' }).catch(console.error);
        }
    }
    
    groups = fetchedGroups;
    renderSidebar();
    renderAdminGroups();
    
    // Auto-select from localStorage on initial load
    if (!activeGroupId) {
        const savedId = localStorage.getItem('activeGroupId');
        if (savedId) {
            const savedGroup = groups.find(g => g.id === savedId && g.enabled);
            if (savedGroup) {
                selectGroup(savedGroup);
            }
        }
    }
}

function renderSidebar() {
    const list = document.getElementById('groups-list');
    list.innerHTML = '';
    
    let visible = groups.filter(g => g.enabled);
    
    if (searchQuery) {
        visible = visible.filter(g => g.name.toLowerCase().includes(searchQuery));
        // Sort: most relevant (exact match or starts with) at the top
        visible.sort((a, b) => {
            const aStarts = a.name.toLowerCase().startsWith(searchQuery) ? -1 : 0;
            const bStarts = b.name.toLowerCase().startsWith(searchQuery) ? -1 : 0;
            return aStarts - bStarts;
        });
    }

    if (visible.length === 0) {
        list.innerHTML = `<div class="p-6 text-sm text-slate-500 text-center">${searchQuery ? 'No groups found.' : 'No groups enabled by Admin yet.'}</div>`;
        return;
    }

    visible.forEach(g => {
        const div = document.createElement('div');
        const isActive = g.id === activeGroupId;
        div.className = `w-full text-left px-3 py-3 flex items-start gap-3 hover:bg-slate-50 border-b border-slate-100 transition cursor-pointer ${isActive ? 'bg-emerald-50/60' : ''}`;
        div.onclick = () => selectGroup(g);
        
        const time = new Date(g.lastAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const unread = g.unread || 0;
        
        div.innerHTML = `
            <div class="w-10 h-10 rounded-full bg-gradient-to-br from-brand-primary to-brand-deep text-white flex items-center justify-center font-semibold shrink-0">${g.name.slice(0,1)}</div>
            <div class="flex-1 min-w-0">
                <div class="flex justify-between items-center">
                    <div class="font-medium text-[14px] truncate">${g.name}</div>
                    <div class="text-[10px] text-slate-400 ml-2">${time}</div>
                </div>
                <div class="flex justify-between items-center mt-0.5">
                    <div class="text-[12px] text-slate-500 truncate">${g.lastPreview || 'No messages'}</div>
                    ${unread > 0 ? `<span class="px-1.5 py-0.5 rounded-full bg-brand-primary text-white text-[10px] shadow-sm">${unread}</span>` : ''}
                </div>
            </div>
        `;
        list.appendChild(div);
    });
}

async function selectGroup(group) {
    activeGroupId = group.id;
    localStorage.setItem('activeGroupId', group.id);
    socket.emit('join-group', group.id);
    
    // Clear unread count for this group in DB and UI
    group.unread = 0;
    fetch(`/api/groups/${group.id}/read`, { method: 'POST' }).catch(console.error);
    renderSidebar();
    
    document.getElementById('active-group-header').classList.remove('hidden');
    document.getElementById('chat-input-area').classList.remove('hidden');
    document.getElementById('active-group-name').innerText = group.name;
    document.getElementById('active-group-anon').innerText = `Anonymized · ${group.anon_counter || 0} unknown participants`;
    
    // Load drafts for this group
    const savedText = localStorage.getItem(`draft_${group.id}`);
    if (savedText) {
        document.getElementById('message-input').value = savedText;
    }
    
    // Load media drafts
    pendingFiles = await loadMediaDraft(group.id);
    if (pendingFiles.length > 0) {
        activePreviewIndex = 0;
        showMediaPreview();
    }
    
    renderSidebar(); // Update active state
    
    currentMessageOffset = 0;
    hasMoreMessages = true;
    isLoadingMore = false;
     const chatBox = document.getElementById('chat-messages');
    chatBox.innerHTML = '';
    chatBox.className = 'flex-1 overflow-y-auto p-4 flex flex-col gap-2 chat-bg thin-scroll';

    // ⚡ Lightning Fast UI: Render from local IndexedDB instantly!
    const localMessages = await loadMessagesFromDb(group.id);
    if (localMessages.length > 0) {
        const fragment = document.createDocumentFragment();
        localMessages.forEach(msg => fragment.appendChild(createMessageWrapper(msg)));
        chatBox.appendChild(fragment);
        lucide.createIcons({ root: chatBox });
        scrollToBottom();
        
        // Setup offset based on what we loaded locally
        currentMessageOffset = localMessages.length;
    } else {
        chatBox.innerHTML = '<div class="text-center text-slate-400 mt-10 text-sm">Loading messages...</div>';
    }
    
    // 🕒 Sync only NEW messages using the timestamp of the last local message
    let afterQuery = '';
    if (localMessages.length > 0) {
        const lastMsg = localMessages[localMessages.length - 1];
        afterQuery = `&after=${encodeURIComponent(lastMsg.created_at || lastMsg.timestamp)}`;
    }
    
    try {
        const res = await fetch(`/api/messages/${encodeURIComponent(group.id)}?limit=50${afterQuery}`);
        const newMessages = await res.json();
        
        // Race Condition Guard
        if (activeGroupId !== group.id) return;
        
        if (newMessages.length > 0) {
            // Save new messages to local cache
            await saveMessagesToDb(newMessages);
            
            if (localMessages.length === 0) {
                chatBox.innerHTML = '';
            }
            
            // Append only the newly synced messages to the UI
            newMessages.forEach(msg => chatBox.appendChild(createMessageWrapper(msg)));
            lucide.createIcons({ root: chatBox });
            scrollToBottom();
            currentMessageOffset += newMessages.length;
        } else if (localMessages.length === 0) {
            chatBox.innerHTML = '<div class="flex items-center justify-center h-full text-slate-400 text-sm">No messages yet.</div>';
        }
        
        if (newMessages.length < 50 && !afterQuery) hasMoreMessages = false;
        
    } catch (e) {
        console.error('Failed to sync messages:', e);
    }
    
    // Infinite Scroll Logic
    chatBox.onscroll = async () => {
        // Toggle Scroll to Bottom button
        const scrollBtn = document.getElementById('scroll-to-bottom-btn');
        if (scrollBtn) {
            const distanceFromBottom = chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight;
            if (distanceFromBottom > 300) {
                scrollBtn.classList.remove('hidden');
                scrollBtn.classList.add('flex');
            } else {
                scrollBtn.classList.add('hidden');
                scrollBtn.classList.remove('flex');
            }
        }

        if (chatBox.scrollTop <= 50 && !isLoadingMore && hasMoreMessages) {
            isLoadingMore = true;
            currentMessageOffset += 50;
            
            const oldScrollHeight = chatBox.scrollHeight;
            
            const moreRes = await fetch(`/api/messages/${encodeURIComponent(group.id)}?limit=50&offset=${currentMessageOffset}`);
            const moreMessages = await moreRes.json();
            
            if (moreMessages.length < 50) hasMoreMessages = false;
            
            if (moreMessages.length > 0) {
                // Save historical messages to cache too
                saveMessagesToDb(moreMessages);
                
                const fragment = document.createDocumentFragment();
                moreMessages.forEach(msg => fragment.appendChild(createMessageWrapper(msg)));
                chatBox.insertBefore(fragment, chatBox.firstChild);
                lucide.createIcons({ root: chatBox });
                
                currentMessageOffset += moreMessages.length;
                chatBox.scrollTop = chatBox.scrollHeight - oldScrollHeight;
            }
            isLoadingMore = false;
        }
    };
}

function appendMessage(msg) {
    const chatBox = document.getElementById('chat-messages');
    
    const wrapper = createMessageWrapper(msg);
    const existing = document.getElementById('msg-node-' + msg.id);
    if (existing) {
        existing.replaceWith(wrapper);
    } else {
        chatBox.appendChild(wrapper);
    }
    // Only parse icons in the newly added wrapper to prevent massive lag!
    lucide.createIcons({ root: wrapper });
}

function formatTextWithLinks(text, isOut) {
    if (!text) return '';
    const escapedText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const linkClass = isOut ? "text-white underline font-semibold hover:text-white/80" : "text-blue-600 underline font-semibold hover:text-blue-800";
    return escapedText.replace(urlRegex, `<a href="$1" target="_blank" class="${linkClass}">$1</a>`);
}

async function forceDownload(url) {
    try {
        const res = await fetch(url);
        const blob = await res.blob();
        const objectUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = url.substring(url.lastIndexOf('/') + 1) || 'download';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(objectUrl);
        a.remove();
    } catch (e) {
        console.error('Download failed, falling back to new tab', e);
        window.open(url, '_blank');
    }
}

function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'fixed bottom-10 left-1/2 -translate-x-1/2 bg-slate-800 text-white px-4 py-2 rounded-full shadow-lg text-sm z-50 transition-opacity duration-300 pointer-events-none';
    toast.innerText = message;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('opacity-0');
        setTimeout(() => toast.remove(), 300);
    }, 2000);
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        showToast('Link copied to clipboard!');
    }).catch(err => {
        console.error('Failed to copy: ', err);
    });
}

function createMessageWrapper(msg) {
    const isOut = msg.direction === 'out';
    const time = new Date(msg.created_at || msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    const wrapper = document.createElement('div');
    wrapper.className = `flex ${isOut ? 'justify-end' : 'justify-start'} w-full group relative`;
    wrapper.id = 'msg-node-' + msg.id;

    
    // Tag Chip
    let tagHtml = '';    if (isOut) {
        tagHtml = `<span class="text-[11px] font-medium text-white/90">You</span>`;
    } else {
        const senderDisp = msg.sender_display || msg.senderDisplay || 'Unknown';
        const isAlias = senderDisp.startsWith('R');
        tagHtml = isAlias 
            ? `<span class="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-emerald-100 text-emerald-800">🔒 ${senderDisp}</span>`
            : `<span class="text-[11px] font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">👤 ${senderDisp}</span>`;
    }

    // Media HTML
    let mediaHtml = '';
    const mediaUrl = msg.media_url || msg.mediaUrl;
    if (mediaUrl) {
        const actionsHtml = `
        <div class="absolute top-2 right-2 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity z-10">
            <button onclick="forceDownload('${mediaUrl}')" class="bg-black/40 hover:bg-black/60 backdrop-blur-sm text-white p-2 rounded-full shadow-sm transition-colors" title="Download">
                <i data-lucide="download" class="w-3.5 h-3.5"></i>
            </button>
            <button onclick="copyToClipboard('${mediaUrl}')" class="bg-black/40 hover:bg-black/60 backdrop-blur-sm text-white p-2 rounded-full shadow-sm transition-colors" title="Copy Link">
                <i data-lucide="link" class="w-3.5 h-3.5"></i>
            </button>
            <a href="${mediaUrl}" target="_blank" class="bg-black/40 hover:bg-black/60 backdrop-blur-sm text-white p-2 rounded-full shadow-sm transition-colors flex items-center justify-center" title="Open in New Tab">
                <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
            </a>
        </div>`;

        if (msg.type === 'image') {
            mediaHtml = `
            <div class="relative group my-1">
                <img src="${mediaUrl}" onclick="openFullscreen('${mediaUrl}', 'image')" class="rounded-lg max-h-64 object-cover cursor-pointer w-full" />
                ${actionsHtml}
            </div>`;
        } else if (msg.type === 'video') {
            mediaHtml = `
            <div class="relative group my-1 cursor-pointer bg-black/10 rounded-lg overflow-hidden max-h-64">
                <div class="flex items-center justify-center h-full" onclick="openFullscreen('${mediaUrl}', 'video')">
                    <video src="${mediaUrl}#t=0.001" preload="metadata" class="w-full h-full object-cover max-h-64 pointer-events-none"></video>
                    <div class="absolute inset-0 flex items-center justify-center pointer-events-none bg-black/20 group-hover:bg-black/30 transition-colors">
                        <div class="w-12 h-12 bg-black/60 rounded-full flex items-center justify-center backdrop-blur-md">
                            <i data-lucide="play" class="w-5 h-5 text-white ml-1"></i>
                        </div>
                    </div>
                </div>
                ${actionsHtml}
            </div>`;
        } else if (msg.type === 'audio') {
            mediaHtml = `<audio src="${mediaUrl}" controls class="w-full max-w-[260px] h-10 my-1"></audio>`;
        } else {
            mediaHtml = `
            <div class="flex items-center gap-3 p-3 rounded-xl border max-w-sm my-1 ${isOut ? 'bg-white/10 border-white/20 text-white' : 'bg-slate-50 border-slate-200 text-slate-700'}">
                <div class="w-10 h-10 shrink-0 rounded-lg flex items-center justify-center ${isOut ? 'bg-white/20' : 'bg-emerald-100 text-emerald-600'}">
                    <i data-lucide="file-text" class="w-5 h-5"></i>
                </div>
                <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium truncate">${msg.text || 'Document'}</div>
                </div>
                <div class="flex items-center gap-1 shrink-0 ml-2">
                    <button onclick="forceDownload('${mediaUrl}')" class="p-1.5 opacity-70 hover:opacity-100" title="Download"><i data-lucide="download" class="w-4 h-4"></i></button>
                    <button onclick="copyToClipboard('${mediaUrl}')" class="p-1.5 opacity-70 hover:opacity-100" title="Copy Link"><i data-lucide="link" class="w-4 h-4"></i></button>
                    <a href="${mediaUrl}" target="_blank" class="p-1.5 opacity-70 hover:opacity-100" title="Open in New Tab"><i data-lucide="external-link" class="w-4 h-4"></i></a>
                </div>
            </div>`;
        }
    }

    // Quoted Msg HTML
    let quotedHtml = '';
    const quotedMsg = msg.quoted_msg || msg.quotedMsg;
    if (quotedMsg) {
        // Keeping sender data in JS object if needed, but NOT displaying it in the UI
        quotedHtml = `
            <div onclick="scrollToMessage('${quotedMsg.id}')" class="mb-2 rounded-lg overflow-hidden border-l-4 px-2 py-2 text-[12px] cursor-pointer hover:opacity-80 transition-opacity ${isOut ? 'bg-emerald-700/50 border-white/50 text-white/90' : 'bg-slate-100 border-emerald-500 text-slate-700'}">
                <div class="truncate">${quotedMsg.text || 'Media'}</div>
            </div>
        `;
    }

    const textHtml = (msg.text && msg.type !== 'document') ? `<div class="text-[14px] leading-snug whitespace-pre-wrap break-words mt-1">${formatTextWithLinks(msg.text, isOut)}</div>` : '';

    // Hover actions
    const hoverHtml = `
        <div class="absolute ${isOut ? '-left-[84px]' : '-right-[84px] flex-row-reverse'} top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onclick='setReply(${JSON.stringify(msg).replace(/'/g, "&#39;")})' class="p-1.5 rounded-full bg-white border shadow-sm hover:bg-slate-50 transition-colors" title="Reply">
                <i data-lucide="reply" class="w-3.5 h-3.5 text-slate-600"></i>
            </button>
            ${msg.text ? `<button onclick="navigator.clipboard.writeText('${msg.text.replace(/'/g, "\\'")}'); showToast('Text copied!')" class="p-1.5 rounded-full bg-white border shadow-sm hover:bg-slate-50 transition-colors" title="Copy"><i data-lucide="copy" class="w-3.5 h-3.5 text-slate-600"></i></button>` : ''}
            
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
        const reacts = Object.keys(msg.reactions).join(' ');
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
    
    return wrapper;
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
    const btn = document.getElementById('scroll-to-bottom-btn');
    if (btn) {
        btn.classList.add('hidden');
        btn.classList.remove('flex');
    }
}

// Media Preview & Sending Logic
function showMediaPreview() {
    const editor = document.getElementById('fullscreen-media-editor');
    const strip = document.getElementById('fs-thumbnail-strip');
    const mainPreview = document.getElementById('fs-main-preview');
    const captionInput = document.getElementById('fs-media-caption');
    
    if (pendingFiles.length === 0) {
        closeMediaPreview();
        return;
    }
    
    // Ensure index is valid
    if (activePreviewIndex >= pendingFiles.length) {
        activePreviewIndex = Math.max(0, pendingFiles.length - 1);
    }
    
    editor.classList.remove('hidden');
    editor.classList.add('flex');
    document.getElementById('chat-messages').classList.add('hidden');
    document.getElementById('chat-input-area').classList.add('hidden');
    
    strip.innerHTML = '';
    
    const activeFile = pendingFiles[activePreviewIndex];
    
    // Main preview
    if (activeFile.type.startsWith('image/')) {
        mainPreview.innerHTML = `<img src="${activeFile.previewUrl}" class="max-w-full max-h-full object-contain rounded-md shadow-lg" />`;
    } else if (activeFile.type.startsWith('video/')) {
        mainPreview.innerHTML = `<video src="${activeFile.previewUrl}" controls class="max-w-full max-h-full object-contain rounded-md shadow-lg"></video>`;
    } else {
        mainPreview.innerHTML = `<div class="bg-white p-10 rounded-xl shadow-lg flex flex-col items-center gap-4"><i data-lucide="file" class="w-20 h-20 text-slate-400"></i><span class="font-medium text-slate-700">${activeFile.name}</span></div>`;
    }
    
    captionInput.value = activeFile.customCaption || '';
    captionInput.focus();
    
    // Thumbnails
    pendingFiles.forEach((file, index) => {
        const wrap = document.createElement('div');
        const isActive = index === activePreviewIndex;
        wrap.className = `relative w-16 h-16 shrink-0 rounded-md flex items-center justify-center overflow-hidden group cursor-pointer transition-all border-2 ${isActive ? 'border-brand-primary scale-110 shadow-md' : 'border-transparent opacity-70 hover:opacity-100'}`;
        wrap.onclick = () => {
            activePreviewIndex = index;
            showMediaPreview();
        };
        
        let mediaHtml = '';
        if (file.type.startsWith('image/')) {
            mediaHtml = `<img src="${file.previewUrl}" class="w-full h-full object-cover" />`;
        } else if (file.type.startsWith('video/')) {
            mediaHtml = `<video src="${file.previewUrl}" class="w-full h-full object-cover"></video>`;
        } else {
            mediaHtml = `<div class="bg-slate-200 w-full h-full flex items-center justify-center"><i data-lucide="file" class="w-6 h-6 text-slate-400"></i></div>`;
        }
        
        wrap.innerHTML = `
            ${mediaHtml}
            <button onclick="event.stopPropagation(); removePendingFile(${index})" class="absolute top-0.5 right-0.5 bg-red-500 hover:bg-red-600 text-white p-0.5 rounded-full opacity-0 group-hover:opacity-100 transition-opacity">
                <i data-lucide="x" class="w-3 h-3"></i>
            </button>
        `;
        strip.appendChild(wrap);
    });
    
    lucide.createIcons();
}

function removePendingFile(index) {
    pendingFiles.splice(index, 1);
    saveMediaDraft(activeGroupId);
    
    if (pendingFiles.length === 0) {
        closeMediaPreview();
    } else {
        if (activePreviewIndex >= pendingFiles.length) {
            activePreviewIndex = pendingFiles.length - 1;
        }
        showMediaPreview();
    }
}

// Scroll to Quoted Message
function scrollToMessage(id) {
    const el = document.getElementById('msg-node-' + id);
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        
        // Full row yellow highlight overlay
        const overlay = document.createElement('div');
        overlay.className = 'absolute inset-0 bg-yellow-500/20 pointer-events-none transition-opacity duration-500 z-[5] rounded-lg';
        overlay.style.opacity = '1';
        
        el.appendChild(overlay);
        
        setTimeout(() => {
            overlay.style.opacity = '0';
            setTimeout(() => {
                overlay.remove();
            }, 500);
        }, 1200);
        
    } else {
        showToast('Message not loaded locally');
    }
}

function closeMediaPreview() {
    document.getElementById('fullscreen-media-editor').classList.add('hidden');
    document.getElementById('fullscreen-media-editor').classList.remove('flex');
    document.getElementById('chat-messages').classList.remove('hidden');
    document.getElementById('chat-input-area').classList.remove('hidden');
    
    document.getElementById('file-input').value = '';
    document.getElementById('fs-add-file').value = '';
    document.getElementById('fs-media-caption').value = '';
    pendingFiles = [];
    activePreviewIndex = 0;
    saveMediaDraft(activeGroupId);
    scrollToBottom();
}

async function sendMediaFromEditor() {
    if (pendingFiles.length === 0 || !activeGroupId) return;

    const filesToSend = [...pendingFiles];
    const replyContext = window.replyMsg ? window.replyMsg.id : null;
    
    closeMediaPreview();
    const chatContainer = document.getElementById('chat-messages');
    
    for (let i = 0; i < filesToSend.length; i++) {
        const file = filesToSend[i];
        const caption = file.customCaption || '';
        
        // Optimistic UI per file
        let mediaHtml = '';
        if (file.type.startsWith('image/')) {
            mediaHtml = `<img src="${file.previewUrl}" class="rounded-lg max-h-64 object-cover my-1 w-full" />`;
        } else if (file.type.startsWith('video/')) {
            mediaHtml = `<video src="${file.previewUrl}" class="rounded-lg max-h-64 object-cover my-1 w-full"></video>`;
        } else {
            mediaHtml = `<div class="my-1 text-sm italic opacity-90 flex items-center gap-2"><i data-lucide="file" class="w-4 h-4"></i> ${file.name}</div>`;
        }
        
        const optDiv = document.createElement('div');
        optDiv.className = 'flex justify-end mb-4 animate-pulse opacity-80 optimistic-msg-node';
        optDiv.innerHTML = `
            <div class="max-w-[75%] rounded-2xl p-3 shadow-sm bg-emerald-500 text-white rounded-tr-none border border-transparent">
                <div class="flex items-center gap-2 text-xs opacity-75 mb-1 font-medium">
                    <span>You</span>
                    <i data-lucide="clock" class="w-3 h-3"></i> Sending...
                </div>
                ${mediaHtml}
                ${caption ? `<div class="text-[14px] leading-relaxed break-words whitespace-pre-wrap mt-1">${caption}</div>` : ''}
            </div>
        `;
        chatContainer.appendChild(optDiv);
        lucide.createIcons();
        scrollToBottom();
        
        // Async Upload and Send in background
        (async () => {
            let type = 'document';
            if (file.type.startsWith('image/')) type = 'image';
            else if (file.type.startsWith('video/')) type = 'video';
            else if (file.type.startsWith('audio/')) type = 'audio';

            const fd = new FormData();
            fd.append('file', file);
            
            try {
                const upRes = await fetch('/api/upload', { method: 'POST', body: fd });
                const upData = await upRes.json();
                if (upData.error) throw new Error(upData.error);
                
                const payload = {
                    groupId: activeGroupId,
                    text: caption,
                    type: type,
                    media: upData.url
                };

                if (i === 0 && replyContext) {
                    payload.quotedMsgId = replyContext;
                }

                await fetch('/api/messages/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                
            } catch (e) {
                console.error('Upload failed:', e);
                optDiv.classList.remove('animate-pulse');
                optDiv.innerHTML = `<div class="text-red-500 text-sm p-2 bg-red-100 rounded">Failed to upload ${file.name}</div>`;
            }
        })();
    }
    
    if (window.replyMsg) clearReply();
}

async function sendMessage() {
    const input = document.getElementById('message-input');
    const text = input.value;
    
    if (!text.trim() || !activeGroupId) return;

    input.value = '';
    localStorage.removeItem(`draft_${activeGroupId}`);
    
    const chatContainer = document.getElementById('chat-messages');
    const optDiv = document.createElement('div');
    optDiv.className = 'flex justify-end mb-4 animate-pulse opacity-80 optimistic-msg-node';
    optDiv.innerHTML = `
        <div class="max-w-[75%] rounded-2xl p-3 shadow-sm bg-emerald-500 text-white rounded-tr-none border border-transparent">
            <div class="flex items-center gap-2 text-xs opacity-75 mb-1 font-medium">
                <span>You</span>
                <i data-lucide="clock" class="w-3 h-3"></i> Sending...
            </div>
            <div class="text-[14px] leading-relaxed break-words whitespace-pre-wrap mt-1">${formatTextWithLinks(text, true)}</div>
        </div>
    `;
    chatContainer.appendChild(optDiv);
    lucide.createIcons();
    scrollToBottom();

    const payload = {
        groupId: activeGroupId,
        text: text,
        type: 'text',
        media: null
    };

    if (window.replyMsg) {
        payload.quotedMsgId = window.replyMsg.id;
        clearReply();
    }

    try {
        await fetch('/api/messages/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
    } catch(e) {
        console.error(e);
        optDiv.classList.remove('animate-pulse');
        optDiv.innerHTML = `<div class="text-red-500 text-sm p-2 bg-red-100 rounded">Failed to send</div>`;
    }
}

function setReply(msg) {
    window.replyMsg = msg;
    document.getElementById('message-input').focus();
    
    // Show Preview
    const container = document.getElementById('reply-preview-container');
    if (container) {
        document.getElementById('reply-preview-sender').innerText = msg.sender_display || msg.senderDisplay || 'Unknown';
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
        fetchSettings();
    } else {
        pinInput.classList.add('shake', 'border-red-500');
        setTimeout(() => pinInput.classList.remove('shake', 'border-red-500'), 400);
    }
}

function switchTab(tab) {
    document.getElementById('tab-qr').className = `pb-2 border-b-2 font-medium ${tab === 'qr' ? 'border-brand-primary text-brand-primary' : 'border-transparent text-slate-500'}`;
    document.getElementById('tab-groups').className = `pb-2 border-b-2 font-medium ${tab === 'groups' ? 'border-brand-primary text-brand-primary' : 'border-transparent text-slate-500'}`;
    document.getElementById('tab-auto-delete').className = `pb-2 border-b-2 font-medium ${tab === 'auto-delete' ? 'border-brand-primary text-brand-primary' : 'border-transparent text-slate-500'}`;
    
    document.getElementById('content-qr').classList.toggle('hidden', tab !== 'qr');
    document.getElementById('content-groups').classList.toggle('hidden', tab !== 'groups');
    document.getElementById('content-auto-delete').classList.toggle('hidden', tab !== 'auto-delete');
    
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
                <button onclick="toggleGroup('${group.id}', ${!group.enabled}, this)" class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${group.enabled ? 'bg-brand-primary' : 'bg-slate-200'}">
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

async function toggleGroup(id, enabled, btnEl) {
    // Optimistic UI Update
    if (btnEl) {
        const dot = btnEl.querySelector('span');
        if (enabled) {
            btnEl.classList.replace('bg-slate-200', 'bg-brand-primary');
            dot.classList.replace('translate-x-0', 'translate-x-4');
        } else {
            btnEl.classList.replace('bg-brand-primary', 'bg-slate-200');
            dot.classList.replace('translate-x-4', 'translate-x-0');
        }
    }

    await fetch('/api/admin/toggle-group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: currentPin, groupId: id, enabled })
    });
}

// Auto-Delete Settings Logic
async function fetchSettings() {
    try {
        const res = await fetch('/api/admin/settings');
        const settings = await res.json();
        
        document.getElementById('auto-delete-toggle').checked = settings.auto_delete_enabled;
        document.getElementById('auto-delete-days').value = settings.auto_delete_days || 60;
        updateAutoDeleteUI();
    } catch (e) {
        console.error('Failed to fetch settings', e);
    }
}

function updateAutoDeleteUI() {
    const isEnabled = document.getElementById('auto-delete-toggle').checked;
    const daysInput = document.getElementById('auto-delete-days');
    const optionsContainer = document.getElementById('auto-delete-options');
    const dot = document.getElementById('auto-delete-status-dot');
    
    if (isEnabled) {
        optionsContainer.classList.remove('opacity-50', 'pointer-events-none');
    } else {
        optionsContainer.classList.add('opacity-50', 'pointer-events-none');
    }
    
    let days = parseInt(daysInput.value);
    if (isNaN(days)) days = 60;
    if (days < 15) days = 15;
    if (days > 90) days = 90;
    
    if (days < 30) {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]';
    } else {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]';
    }
}

async function saveSettings() {
    const isEnabled = document.getElementById('auto-delete-toggle').checked;
    const daysInput = document.getElementById('auto-delete-days');
    
    let days = parseInt(daysInput.value);
    if (isNaN(days) || days < 15) days = 15;
    if (days > 90) days = 90;
    daysInput.value = days;
    
    const newPinInput = document.getElementById('new-admin-pin');
    const newPin = newPinInput ? newPinInput.value.trim() : '';
    
    try {
        const payload = {
            pin: currentPin,
            auto_delete_enabled: isEnabled,
            auto_delete_days: days
        };
        if (newPin) {
            payload.new_admin_pin = newPin;
        }
        
        const res = await fetch('/api/admin/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || 'Failed to save');
        }
        
        if (newPin) {
            currentPin = newPin;
            if (newPinInput) newPinInput.value = '';
        }
        
        const msg = document.getElementById('settings-save-msg');
        msg.classList.remove('hidden');
        setTimeout(() => msg.classList.add('hidden'), 3000);
    } catch (e) {
        console.error('Failed to save settings', e);
        alert('Failed to save: ' + e.message);
    }
}

