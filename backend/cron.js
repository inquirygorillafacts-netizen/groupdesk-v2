const { supabase } = require('./supabase');

async function runAutoDelete() {
    try {
        console.log('🧹 [CRON] Starting Auto-Delete check...');
        
        // 1. Fetch settings
        const { data: settings, error: settingsError } = await supabase
            .from('app_settings')
            .select('*')
            .eq('id', 1)
            .single();
            
        if (settingsError || !settings || !settings.auto_delete_enabled) {
            console.log('🧹 [CRON] Auto-Delete is disabled or settings not found. Skipping.');
            return;
        }

        const days = settings.auto_delete_days || 60;
        const thresholdDate = new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString();
        
        console.log(`🧹 [CRON] Deleting messages older than ${days} days (Before: ${thresholdDate})...`);

        // 2. Find messages to delete that have media attached
        const { data: messagesToDelete, error: fetchError } = await supabase
            .from('messages')
            .select('id, media_url')
            .lt('created_at', thresholdDate);
            
        if (fetchError) throw fetchError;
        
        if (!messagesToDelete || messagesToDelete.length === 0) {
            console.log('🧹 [CRON] No old messages found to delete.');
            return;
        }

        // 3. Delete media files from Supabase Storage
        const filesToDelete = messagesToDelete
            .filter(msg => msg.media_url)
            .map(msg => msg.media_url.split('/').pop()); // Extract filename from URL

        if (filesToDelete.length > 0) {
            console.log(`🧹 [CRON] Deleting ${filesToDelete.length} media files from Storage...`);
            const { error: storageError } = await supabase.storage.from('uploads').remove(filesToDelete);
            if (storageError) console.error('🧹 [CRON] Error deleting files:', storageError);
        }

        // 4. Delete the message rows from database
        console.log(`🧹 [CRON] Deleting ${messagesToDelete.length} message records from Database...`);
        const { error: deleteError } = await supabase
            .from('messages')
            .delete()
            .lt('created_at', thresholdDate);
            
        if (deleteError) throw deleteError;
        
        console.log('✅ [CRON] Auto-Delete completed successfully!');
        
    } catch (e) {
        console.error('🧹 [CRON] Auto-Delete failed:', e);
    }
}

// Clean up all temporary WhatsApp session keys that accumulate endlessly
// SAFE: creds.json, device-list-*, identity-key-*, app-state-sync-version-* are NEVER touched
async function cleanAuthState() {
    try {
        console.log('🧹 [CRON] Cleaning up stale auth_state keys...');
        
        const typesToDelete = [
            'app-state-sync-key-%',  // sync keys (main bloat)
            'lid-mapping-%',          // contact ID mappings
            'pre-key-%',              // encryption pre-keys (1600+ rows!)
            'session-%',              // session keys (temporary)
            'tctoken-%',              // token keys (temporary)
            'sender-key-%',           // sender keys (regenerated per session)
        ];

        for (const pattern of typesToDelete) {
            const { error } = await supabase
                .from('auth_state')
                .delete()
                .like('file_name', pattern);
            if (error) console.error(`[CRON] Failed to delete ${pattern}:`, error.message);
        }

        const { count } = await supabase
            .from('auth_state')
            .select('*', { count: 'exact', head: true });
        
        console.log(`✅ [CRON] auth_state cleanup done. Remaining rows: ${count}`);
    } catch (e) {
        console.error('🧹 [CRON] auth_state cleanup failed:', e.message);
    }
}

function initCron() {
    console.log('🕒 Initializing Background Cron Jobs...');
    
    // Run once on startup (after 30 seconds to allow WhatsApp to fully connect first)
    setTimeout(() => {
        runAutoDelete();
        cleanAuthState();
    }, 30000);
    
    // Run every 24 hours
    setInterval(() => {
        runAutoDelete();
        cleanAuthState();
    }, 24 * 60 * 60 * 1000);
}

module.exports = { initCron };

