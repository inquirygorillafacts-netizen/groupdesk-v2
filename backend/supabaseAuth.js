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
