# Message Interactions Guide (Reactions & Quoted Replies)

यह डॉक्यूमेंट समझाता है कि **GroupDesk V2** में WhatsApp Reactions (👍, ❤️) और Quoted Replies (किसी पुराने मैसेज का रिप्लाई देना) कैसे काम करते हैं।

---

## 1. Reactions (रिएक्शन कैसे काम करते हैं?)

जब कोई यूज़र असली WhatsApp ऐप से किसी मैसेज पर रिएक्ट करता है, तो बैकएंड उसे कैसे समझता है और UI पर कैसे दिखाता है, इसका पूरा फ्लो नीचे दिया गया है:

### A. Backend Logic (`backend/whatsapp.js`)
जब भी कोई नया मैसेज आता है, तो हम `messages.upsert` इवेंट लिसनर के ज़रिए उसे पकड़ते हैं।
1. **पहचानना (Identification):** नॉर्मल मैसेज के बजाय, WhatsApp इसे `msg.message.reactionMessage` के रूप में भेजता है।
2. **डेटा निकालना (Extraction):** 
   - `reactionText` (कौन सा इमोजी है, जैसे 👍)
   - `targetMsgId` (किस पुराने मैसेज पर रिएक्ट किया गया है)
3. **डेटाबेस अपडेट (Database Update):** हम Supabase में मौजूद `messages` टेबल से उस पुराने मैसेज (`targetMsgId`) को ढूँढते हैं। फिर उसके `reactions` कॉलम (जो कि एक JSONB ऑब्जेक्ट है, जैसे `{"👍": 1}`) में नया रिएक्शन जोड़ देते हैं।
4. **UI अपडेट (Socket Emission):** डेटाबेस अपडेट करने के बाद, बैकएंड `io.to(jid).emit('new-message', updatedMsg);` के ज़रिए Frontend को नया मैसेज डेटा भेज देता है। 

*(नोट: चूँकि हमने रिएक्शन को टेक्स्ट मैसेज बनने से पहले ही पकड़ लिया है, इसलिए अब डेटाबेस में कोई भी फालतू "खाली" मैसेज नहीं बनता।)*

### B. Frontend Logic (`frontend/js/app.js`)
1. Frontend पर Socket.io के ज़रिए जब अपडेटेड मैसेज आता है, तो `appendMessage(msg)` फंक्शन चेक करता है कि क्या यह मैसेज स्क्रीन पर पहले से मौजूद है (`msg-node-{id}`)।
2. अगर मौजूद है, तो वह पुराने डब्बे (Bubble) को नए डब्बे से Replace (बदल) कर देता है।
3. नए डब्बे के HTML (लाइनों 914-919 के आसपास) में, हम `msg.reactions` ऑब्जेक्ट को पढ़ते हैं और मैसेज बबल के बिल्कुल नीचे एक छोटा सा सफ़ेद डब्बा बनाकर उसमें सारे इमोजी दिखा देते हैं।

---

## 2. Quoted Replies (कोटेड रिप्लाई कैसे काम करते हैं?)

जब कोई यूज़र किसी पुराने मैसेज को दाईं ओर स्वाइप करके उसका रिप्लाई देता है, तो वह कैसे हैंडल होता है:

### A. Backend Logic (`backend/whatsapp.js`)
1. **पहचानना:** जब मैसेज आता है, तो बैकएंड `msg.message.extendedTextMessage.contextInfo.quotedMessage` के अंदर चेक करता है।
2. **डेटा निकालना:** अगर `quotedMessage` मिलता है, तो बैकएंड एक `quotedMsg` ऑब्जेक्ट बनाता है जिसमें 4 चीज़ें होती हैं:
   - `id`: ओरिजिनल मैसेज की ID (`stanzaId`)
   - `text`: ओरिजिनल मैसेज में क्या लिखा था
   - `type`: वह इमेज थी या टेक्स्ट
   - `sender`: ओरिजिनल मैसेज किसने भेजा था (Participant JID)
3. **डेटाबेस सेव (Database Save):** यह पूरा ऑब्जेक्ट Supabase के `messages` टेबल के `quoted_msg` (JSONB) कॉलम में सेव हो जाता है।

### B. Frontend Logic (`frontend/js/app.js`)
1. **डिस्प्ले (Rendering):** `createMessageWrapper` फंक्शन में, अगर किसी मैसेज के पास `quotedMsg` होता है, तो वह एक हरा/ग्रे रंग का डब्बा (Quote Box) बनाता है। 
   - **Sender ID Cleanup:** अगर सेंडर का नाम `@s.whatsapp.net` या `@id` के साथ आता है, तो हम `@` के बाद का कचरा हटा देते हैं ताकि UI साफ लगे।
2. **Click & Scroll (Yellow Highlight):** हमने इस Quote Box पर `onclick="scrollToMessage('${quotedMsg.id}')"` लगाया है।
   - जब यूज़र इस पर क्लिक करता है, तो `scrollToMessage` फंक्शन चलता है।
   - यह फंक्शन `scrollIntoView()` की मदद से स्क्रीन को स्मूथली (Smoothly) उस ओरिजिनल मैसेज तक ऊपर ले जाता है।
   - **WhatsApp Style Highlight:** फिर यह कोड उस पूरी लाइन (Full Row) पर 1.2 सेकंड के लिए पीले रंग का (`bg-yellow-500/20`) एक पर्दा (Overlay) डाल देता है, जो धीरे-धीरे गायब (Fade out) हो जाता है। इससे यूज़र को एकदम साफ़ समझ आ जाता है कि "अच्छा, यह रिप्लाई इस मैसेज के लिए था!" 
