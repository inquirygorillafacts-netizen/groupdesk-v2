# 🎨 Frontend Documentation (GroupDesk V2)

## 📌 परिचय (Introduction)
यह फ़ोल्डर GroupDesk V2 का "चेहरा" (UI) है, जो कर्मचारियों और बॉस को ब्राउज़र में दिखता है। 

इसे किसी भी **बिगिनर (BCA 1st Year)** के समझने के लिए **बहुत ही आसान** बनाया गया है। इसमें **React, Webpack या npm build** का कोई झंझट नहीं है। यह शुद्ध (Pure) HTML, CSS और JavaScript पर बना है।

**Tech Stack:** HTML5, Vanilla JavaScript (`app.js`), Tailwind CSS (CDN), Socket.io Client, Lucide Icons.

## 🚀 डायरेक्टरी स्ट्रक्चर (What's inside?)
- **`index.html`**: एक सिंगल पेज जहाँ पूरी चैट स्क्रीन, एडमिन पैनल (Modal) और मल्टीमीडिया प्रीव्यू की कोडिंग है।
- **`css/style.css`**: Tailwind के कस्टम कलर्स (Emerald Theme) और एनिमेशन (`bubble-anim`) का कोड।
- **`js/app.js`**: पूरा दिमाग यहीं है। यह बैकएंड के APIs कॉल करता है और रियल-टाइम चैट सिंक करता है।

---

## 🛠️ यह कैसे काम करता है? (Frontend Flow)

### 1. UI लेआउट (Layout)
- **Header:** ऊपर का हिस्सा जहाँ कनेक्शन स्टेटस (Live/Disconnected) और Settings (⚙️) बटन होता है।
- **Sidebar (Left):** जहाँ सभी ON किए गए ग्रुप्स की लिस्ट आती है।
- **Main Chat Area (Right):** जहाँ चैट्स दिखते हैं। 

### 2. एडमिन फ्लो (Admin PIN Flow)
- जब `⚙️` पर क्लिक किया जाता है, तो `app.js` का `openAdmin()` फंक्शन चलता है।
- यह PIN (1234) मांगता है। 
- अगर PIN सही है, तो बैकएंड `/api/admin/verify` से `true` भेजता है और एडमिन को **QR Code** और **Group Toggles (ON/OFF)** की सेटिंग्स दिख जाती हैं।

### 3. रियल-टाइम चैट (Socket.io)
- `app.js` बैकएंड से Socket के ज़रिए जुड़ा रहता है। 
- जैसे ही बैकएंड से `socket.on('new-message')` आता है, JS तुरंत एक नया HTML `<div>` बनाकर उसे चैट बॉक्स में चिपका (Append) देता है, जिससे बिना रीफ्रेश किए मैसेज दिख जाता है।

### 4. मल्टीमीडिया और फीचर्स (Features)
- **Send Media:** फाइल चुनने पर `showMediaPreview()` चलता है जो फोटो को भेजने से पहले स्क्रीन पर दिखाता है।
- **View Media (Fullscreen):** फोटो पर क्लिक करने पर `openFullscreen()` चलता है जो काले रंग के बैकग्राउंड में फोटो/वीडियो को बड़ा कर देता है।
- **Reply & React:** मैसेज पर होवर करने से Reply (रिप्लाई) और React (इमोजी) के बटन आते हैं, जो सीधा API को कॉल करते हैं।

> **नोट:** पूरा इंटरफ़ेस Tailwind CSS की वजह से मोबाइल और डेस्कटॉप दोनों पर बहुत स्मूथ (मक्खन की तरह) चलता है।
