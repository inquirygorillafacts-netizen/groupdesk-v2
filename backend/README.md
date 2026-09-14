# 🖥️ Backend Documentation (GroupDesk V2)

## 📌 परिचय (Introduction)
यह फ़ोल्डर (Backend) GroupDesk V2 का "दिमाग" है। इसका काम फ्रंटएंड (UI) से रिक्वेस्ट लेना, डेटाबेस से बात करना और WhatsApp (Baileys) के ज़रिए मैसेज भेजना और रिसीव करना है। 

**Tech Stack:** Node.js, Express.js, Socket.io, Baileys (@whiskeysockets/baileys).

## 🚀 यह कैसे काम करता है? (How it works)
इसमें दो मुख्य फाइलें हैं:
1. **`server.js` (Express & Socket.io):** यह API बनाता है और रियल-टाइम कम्युनिकेशन (चैट सिंक) के लिए WebSockets हैंडल करता है। यह `multer` का उपयोग करके मीडिया (Images/Videos) अपलोड भी संभालता है।
2. **`whatsapp.js` (Baileys Logic):** यह बिना ब्राउज़र के सीधे WhatsApp सर्वर से कनेक्ट होता है। यह QR कोड जनरेट करता है, नए मैसेज सुनता है, **Anonymization** (नंबर छिपाकर R1, R2 या PushName दिखाना) का लॉजिक चलाता है, और मैसेज भेजता है।

## 🔐 प्राइवेसी लॉजिक (Anonymization)
जब WhatsApp से कोई मैसेज आता है (`messages.upsert` इवेंट):
- हम चेक करते हैं कि भेजने वाले का नाम (PushName) क्या है।
- अगर नाम है, तो हम सिर्फ नाम दिखाते हैं।
- अगर नाम नहीं है, तो हम `database` में चेक करते हैं कि क्या उसे पहले से कोई Alias (जैसे R1, R2) दिया गया है। अगर नहीं, तो नया Alias (R+1) जनरेट करके सेव करते हैं।
- **असली नंबर कभी भी फ्रंटएंड को नहीं भेजा जाता है।**

---

## 📡 API Endpoints (रास्ते जिनका फ्रंटएंड इस्तेमाल करता है)

### 1. Groups & Messages
- **`GET /api/groups`** 
  - क्या करता है: डेटाबेस से सभी WhatsApp ग्रुप्स की लिस्ट लाता है।
- **`GET /api/messages/:groupId`**
  - क्या करता है: किसी खास ग्रुप की चैट हिस्ट्री (मैसेजेस) लाता है।
- **`POST /api/messages/send`**
  - Payload: `{ groupId, text, type, media, quotedMsgId }`
  - क्या करता है: यह WhatsApp (Baileys) के ज़रिए मैसेज भेजता है और उसे डेटाबेस में सेव करता है।
- **`POST /api/messages/react`**
  - Payload: `{ groupId, messageId, reaction }`
  - क्या करता है: किसी मैसेज पर इमोजी रिएक्शन (👍) लगाता है।

### 2. Admin & Settings
- **`POST /api/admin/verify`**
  - Payload: `{ pin }`
  - क्या करता है: बॉस का PIN चेक करता है (Default: 1234)।
- **`POST /api/admin/toggle-group`**
  - Payload: `{ pin, groupId, enabled }`
  - क्या करता है: एडमिन पैनल से ग्रुप को ON/OFF करता है।

### 3. Media Upload
- **`POST /api/upload`**
  - Payload: FormData (file)
  - क्या करता है: फोटो/वीडियो को `uploads/` फ़ोल्डर में सेव करके उसका URL देता है।

---

## ⚡ Socket.io Events (रियल-टाइम)
- **`new-message`**: जब नया मैसेज आता है या भेजा जाता है, तो तुरंत फ्रंटएंड को मिलता है।
- **`groups-updated`**: जब किसी ग्रुप में नया मैसेज आता है, तो साइडबार अपडेट करने के लिए।
- **`qr-code`**: जब बॉस को WhatsApp लॉगिन करने के लिए QR स्कैन करना होता है।
- **`wa-status`**: WhatsApp कनेक्टेड है या डिसकनेक्टेड, यह बताता है।
