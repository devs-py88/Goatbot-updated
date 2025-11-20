const axios = require('axios');
const fs = require('fs-extra'); 
const path = require('path');

const API_ENDPOINT = "https://e141d348-6fe2-4fcd-acf9-8b35dddddc38-00-3ugo7tquycqjc.sisko.replit.dev/generate";

function extractImageUrl(message, args, event) {
    let imageUrl = args.find(arg => arg.startsWith('http'));

    if (!imageUrl && event.messageReply && event.messageReply.attachments && event.messageReply.attachments.length > 0) {
        const imageAttachment = event.messageReply.attachments.find(att => att.type === 'photo' || att.type === 'image');
        if (imageAttachment && imageAttachment.url) {
            imageUrl = imageAttachment.url;
        }
    }
    return imageUrl;
}

async function downloadImageAsBase64(url, tempDir) {
    const tempPath = path.join(tempDir, `ref_${Date.now()}.png`);
    let base64String = null;
    
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data, 'binary');
        
        base64String = buffer.toString('base64');
        
        return `data:${response.headers['content-type']};base64,${base64String}`;
        
    } catch (e) {
        throw new Error("Failed to process reference image for Base64 encoding.");
    } finally {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
}

async function downloadAndSaveFile(url, tempDir, fileName) {
    let tempFilePath = path.join(tempDir, fileName);
    
    try {
        const response = await axios({
            method: 'get',
            url: url,
            responseType: 'stream'
        });

        const writer = fs.createWriteStream(tempFilePath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on("finish", resolve);
            writer.on("error", (err) => {
                writer.close();
                reject(err);
            });
        });

        return tempFilePath;

    } catch (e) {
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        throw new Error("Failed to download the image file.");
    }
}


module.exports = {
  config: {
    name: "midjourney",
    aliases: ["mj", "imagine"],
    version: "2.1",
    author: "NeoKEX", 
    countDown: 45, 
    role: 0,
    longDescription: "Generate images using the Midjourney API with an optional image reference (--cref).",
    category: "ai-image",
    guide: {
      en: "{pn} [prompt] --cref [imgurl] OR reply to an image."
    }
  },

  onStart: async function({ message, args, event, commandName }) {
    let rawPrompt = args.join(" ").trim();
    const cacheDir = path.join(__dirname, 'cache');
    let referenceImageUrl = null;
    let base64Image = null;

    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

    const crefMatch = rawPrompt.match(/--cref\s*([^\s]+)/i);

    if (crefMatch) {
        referenceImageUrl = crefMatch[1];
        rawPrompt = rawPrompt.replace(crefMatch[0], '').trim();
    } else if (event.messageReply) {
        referenceImageUrl = extractImageUrl(message, [], event);
    }

    const prompt = rawPrompt.trim();

    if (!prompt) {
      return message.reply("❌ Please provide a detailed prompt to generate images.");
    }

    message.reaction("⏳", event.messageID);
    let tempGridPath;

    try {
      if (referenceImageUrl) {
          message.reply("🔄 Processing reference image (Base64 encoding)...");
          base64Image = await downloadImageAsBase64(referenceImageUrl, cacheDir);
      }
      
      let fullApiUrl = `${API_ENDPOINT}?prompt=${encodeURIComponent(prompt)}`;
      if (base64Image) {
          fullApiUrl += `&base64=${encodeURIComponent(base64Image)}`;
      }

      const apiResponse = await axios.get(fullApiUrl);
      const data = apiResponse.data;

      if (!data.success || !data.merged_image_url || data.image_urls.length !== 4) {
        throw new Error(data.status || "API did not return a valid merged image and four images.");
      }
      
      const mergedImageUrl = data.merged_image_url;
      const imageUrls = data.image_urls;
      
      tempGridPath = await downloadAndSaveFile(mergedImageUrl, cacheDir, `mj_grid_${data.task_id}.webp`);

      const replyBody = 
          `✨ Midjourney image generated\n` +
          (referenceImageUrl ? `[Ref: Included]\n` : ``) +
          `Please reply U1, U2, U3, or U4 for viewing the exact image.`;

      message.reply({
        body: replyBody,
        attachment: fs.createReadStream(tempGridPath)
      }, (err, info) => {
        if (fs.existsSync(tempGridPath)) fs.unlinkSync(tempGridPath); 
        
        if (!err) {
            global.GoatBot.onReply.set(info.messageID, {
                commandName,
                messageID: info.messageID,
                author: event.senderID,
                imageUrls: imageUrls,
                prompt: prompt
            });
        }
      });
      
      message.reaction("✅", event.messageID); 

    } catch (error) {
      message.reaction("❌", event.messageID);
      const errorMessage = error.response ? error.response.data.status || error.response.statusText : error.message;
      console.error("Midjourney Command Error:", error);
      message.reply(`❌ Image generation failed: ${errorMessage}`);
      
      if (tempGridPath && fs.existsSync(tempGridPath)) fs.unlinkSync(tempGridPath);
    }
  },

  onReply: async function({ message, event, Reply, api }) { 
    const { imageUrls, prompt } = Reply;
    const userReply = event.body.trim().toUpperCase(); 
    const cacheDir = path.join(__dirname, 'cache');
    
    let tempImagePath = '';
    let selectedIndex = -1;
    let selectionCode = '';

    if (userReply === 'U1') { selectedIndex = 0; selectionCode = 'U1'; }
    else if (userReply === 'U2') { selectedIndex = 1; selectionCode = 'U2'; }
    else if (userReply === 'U3') { selectedIndex = 2; selectionCode = 'U3'; }
    else if (userReply === 'U4') { selectedIndex = 3; selectionCode = 'U4'; }

    if (selectedIndex === -1) {
        api.unsendMessage(Reply.messageID);
        return message.reply("❌ Invalid selection. Please reply with U1, U2, U3, or U4.");
    }
    
    api.unsendMessage(Reply.messageID);
    
    message.reaction("⏳", event.messageID);

    try {
      const selectedUrl = imageUrls[selectedIndex];
      
      tempImagePath = await downloadAndSaveFile(selectedUrl, cacheDir, `mj_single_${Reply.messageID}_${selectionCode}.png`);
      
      await message.reply({
        body: `✅ Here is your image ${selectionCode} (Prompt: ${prompt})`,
        attachment: fs.createReadStream(tempImagePath)
      });

      message.reaction("✅", event.messageID);

    } catch (error) {
      message.reaction("❌", event.messageID);
      console.error("Selection Download Error:", error);
      message.reply(`❌ Failed to download selected image. Error: ${error.message}`);
    } finally {
      if (tempImagePath && fs.existsSync(tempImagePath)) {
          fs.unlinkSync(tempImagePath);
      }
    }
  }
};