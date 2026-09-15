const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

async function useSupabaseAuthState(supabase, sessionId = 'default') {
    const writeData = async (data, file) => {
        const str = JSON.stringify(data, BufferJSON.replacer);
        await supabase.from('auth_state').upsert({ 
            id: `${sessionId}-${file}`, 
            session_id: sessionId, 
            file_name: file, 
            data: str 
        }, { onConflict: 'id' });

        // 🧹 Prevent DB bloat: keep only the latest 50 app-state-sync-keys
        // These keys accumulate endlessly but WhatsApp only needs recent ones
        // creds.json, device-list-*, identity-key-* are NEVER affected by this
        if (file.startsWith('app-state-sync-key-')) {
            try {
                // Get all app-state-sync-key rows for this session, ordered by id (oldest first)
                const { data: allKeys } = await supabase
                    .from('auth_state')
                    .select('id')
                    .eq('session_id', sessionId)
                    .like('file_name', 'app-state-sync-key-%')
                    .order('id', { ascending: true }); // oldest first

                // If we have more than 50, delete the oldest ones
                if (allKeys && allKeys.length > 50) {
                    const toDelete = allKeys.slice(0, allKeys.length - 50); // keep last 50
                    const idsToDelete = toDelete.map(k => k.id);
                    await supabase.from('auth_state').delete().in('id', idsToDelete);
                }
            } catch (e) {
                // Non-critical — if cleanup fails, just continue
                console.log('[auth_state] cleanup skipped:', e.message);
            }
        }
    };

    const readData = async (file) => {
        try {
            const { data, error } = await supabase
                .from('auth_state')
                .select('data')
                .eq('id', `${sessionId}-${file}`)
                .single();
                
            if (data && data.data) {
                return JSON.parse(data.data, BufferJSON.reviver);
            }
        } catch (error) {
            return null;
        }
        return null;
    };

    const removeData = async (file) => {
        try {
            await supabase.from('auth_state').delete().eq('id', `${sessionId}-${file}`);
        } catch (e) {}
    };

    const creds = await readData('creds.json') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async id => {
                            let value = await readData(`${type}-${id}.json`);
                            if (type === 'app-state-sync-key' && value) {
                                value = require('@whiskeysockets/baileys').proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const file = `${category}-${id}.json`;
                            if (value) {
                                tasks.push(writeData(value, file));
                            } else {
                                tasks.push(removeData(file));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => {
            return writeData(creds, 'creds.json');
        }
    };
}

module.exports = { useSupabaseAuthState };
