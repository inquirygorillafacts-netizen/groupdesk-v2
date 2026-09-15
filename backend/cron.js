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

// Clean up old WhatsApp session keys (app-state-sync keys grow endlessly)
// We keep ONLY: creds.json, device-list-*, identity-key-*, pre-key-*, sender-key-*
// We delete: app-state-sync-key-* (these are the ones causing 14,000+ rows)
async function cleanAuthState() {
    try {
        console.log('🧹 [CRON] Cleaning up stale auth_state keys...');
        const { data, error } = await supabase
            .from('auth_state')
            .delete()
            .like('file_name', 'app-state-sync-key-%');
        
        if (error) throw error;
        console.log('✅ [CRON] auth_state cleanup done.');
    } catch (e) {
        console.error('🧹 [CRON] auth_state cleanup failed:', e.message);
    }
}

function initCron() {
    console.log('🕒 Initializing Background Cron Jobs...');
    
    // Run once on startup (after 10 seconds to allow everything to boot)
    setTimeout(() => {
        runAutoDelete();
        cleanAuthState(); // Also clean stale auth keys on startup
    }, 10000);
    
    // Run every 24 hours (24 * 60 * 60 * 1000 ms)
    setInterval(() => {
        runAutoDelete();
        cleanAuthState(); // Clean auth keys daily
    }, 24 * 60 * 60 * 1000);
}

module.exports = { initCron };
