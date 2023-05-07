import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { Configuration, OpenAIApi } from "openai";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const admin = require("firebase-admin");

import fetch from "node-fetch";
import FormData from "form-data";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";

const serviceAccountPath = "/etc/secrets/FIREBASE_SERVICE_ACCOUNT";
const serviceAccountContent = fs.readFileSync(serviceAccountPath, "utf-8");
const serviceAccount = JSON.parse(serviceAccountContent);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
});

dotenv.config();

const app = express();

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});

const openai = new OpenAIApi(configuration);

const allowedOrigins = ["https://chat-cbd.vercel.app"];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
app.use(express.json());

async function uploadImageToFirebase(imageUrl) {
  try {
    const response = await fetch(imageUrl);
    const buffer = await response.buffer();
    const uniqueId = uuidv4();
    const fileExtension = imageUrl.split(".").pop().split("?")[0];
    const filename = `${uniqueId}.${fileExtension}`;

    const file = admin.storage().bucket().file(filename);
    const writeStream = file.createWriteStream({
      metadata: {
        contentType: response.headers.get("content-type"),
      },
    });

    const uploadPromise = new Promise((resolve, reject) => {
      writeStream.on("error", (error) => reject(error));
      writeStream.on("finish", () => {
        file.getSignedUrl(
          {
            action: "read",
            expires: "03-17-2025",
          },
          (error, url) => {
            if (error) {
              reject(error);
            } else {
              resolve(url);
            }
          }
        );
      });
    });

    writeStream.end(buffer);

    const uploadedImageUrl = await uploadPromise.catch((error) => {
      console.error("Error uploading image:", error);
      throw error;
    });

    return uploadedImageUrl;
  } catch (error) {
    console.error("Error uploading image:", error);
    throw error;
  }
}

const PORT = process.env.PORT || 5000;

function preprocessChatHistory(messages) {
  return messages.map((message) => {
    // Check if the message is an image
    const isImage = message.type === "image";

    // Only return the role and content properties of each message
    return {
      role: message.role,
      content: isImage ? "generated image" : message.content,
    };
  });
}

try {
  app.post("/send-message", async (req, res) => {
    try {
      const { messages, type, activeConversation, userId } = req.body;

      const preprocessedMessages = preprocessChatHistory(messages);

      let newMessage;

      if (type === "image") {
        const imageResponse = await openai.createImage({
          prompt: messages[messages.length - 1].content,
          n: 1,
          size: "256x256",
          response_format: "url",
        });

        const imageUrl = imageResponse.data.data[0].url;
        const uploadedImageUrl = await uploadImageToFirebase(imageUrl);

        newMessage = {
          role: "system",
          content: "",
          images: [uploadedImageUrl],
          type: "image",
        };

        res.status(200).send({
          bot: "",
          type: "image",
          images: [uploadedImageUrl],
        });
      } else {
        const response = await openai.createChatCompletion({
          model: "gpt-3.5-turbo",
          messages: preprocessedMessages,
          temperature: 0.5,
          max_tokens: 10000,
          top_p: 1,
          frequency_penalty: 0.5,
          presence_penalty: 0,
        });

        const botResponse = response.data.choices[0].message.content.trim();

        newMessage = {
          role: "system",
          content: botResponse,
          type: "text",
        };

        res.status(200).send({
          bot: botResponse,
          type: "text",
        });
      }

      // Update the messages array with the new message

      const updatedMessages = [...messages, newMessage];

      await saveConversationToFirebase(
        { id: activeConversation, messages: updatedMessages },
        userId
      );
    } catch (error) {
      const { response } = error;
      let errorMessage = "An unknown error occurred";
      let statusCode = 500; // Add this line to send the correct status code

      if (response && response.data && response.data.error) {
        errorMessage = response.data.error.message;
        statusCode = response.status || 500; // Update the status code if available
      }
      res.status(statusCode).send({ error: errorMessage }); // Send the status code along with the error message
    }
  });
} catch (error) {
  let errorMessage = "An unknown error occurred";
  let statusCode = 500;

  if (error.response && error.response.data && error.response.data.error) {
    errorMessage = error.response.data.error.message;
    statusCode = error.response.status || 500;
  }

  res.status(statusCode).send({ error: errorMessage });
}

async function saveConversationToFirebase(conversation, userId) {
  try {
    const db = admin.firestore();
    const conversationsRef = db.collection(`users/${userId}/conversations`);
    const docRef = conversationsRef.doc(conversation.id);

    await docRef.set(conversation);
  } catch (error) {
    console.error("Error saving conversation:", error);
  }
}

app.listen(process.env.PORT || 5000, () =>
  console.log(
    `Server is running on port http://localhost:${process.env.PORT || 5000}`
  )
);
