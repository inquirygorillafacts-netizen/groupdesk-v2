const mongoose = require('mongoose');

async function connectDB() {
    const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/groupdesk-v2';
    try {
        await mongoose.connect(uri);
        console.log('✅ MongoDB Connected successfully.');
    } catch (error) {
        console.error('❌ MongoDB Connection Error:', error);
    }
}

module.exports = { connectDB };
