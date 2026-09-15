require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
    try {
        console.log('Checking uploads bucket...');
        const { data: buckets, error: listError } = await supabase.storage.listBuckets();
        if (listError) throw listError;
        
        const exists = buckets.find(b => b.name === 'uploads');
        if (!exists) {
            console.log('Creating uploads bucket...');
            const { data, error } = await supabase.storage.createBucket('uploads', { public: true });
            if (error) throw error;
            console.log('Bucket created successfully.');
        } else {
            console.log('Bucket already exists. Ensuring it is public...');
            await supabase.storage.updateBucket('uploads', { public: true });
        }
    } catch(e) {
        console.error('Error:', e.message);
    }
}
run();
