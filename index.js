import dotenv from "dotenv";
import axios from "axios"
import * as cheerio from 'cheerio';
import OpenAI from 'openai';
import { ChromaClient } from 'chromadb';

dotenv.config();

const openai = new OpenAI({
    apiKey: process.env.GEMINI_API_KEY,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
});

const chromaClient = new ChromaClient({ path: "http://localhost:8000" });
chromaClient.heartbeat();

const WEB_COLLECTION = `WEB-SCRAPPED_COLLECTION-1`

const scrapeWebPage = async (url) => {
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);

    const pageHead = $('head').html();
    const pageBody = $('body').html();

    const externalLinks = new Set();
    const internalLinks = new Set();

    $('a').each((_, el) => {
        const link = $(el).attr("href");
        // console.log({ link });
        if (!link || link == "/" || link == "#") return;
        if (link.startsWith("http") || link.startsWith("https")) {
            externalLinks.add(link);
        } else {
            internalLinks.add(link);
        }
    })
    return {
        head: pageHead,
        body: pageBody,
        internalLinks: Array.from(internalLinks),
        externalLinks: Array.from(externalLinks)
    }
}

const generateVectorEmbeddings = async ({ text }) => {
    const embedding = await openai.embeddings.create({
        model: "text-embedding-004",
        input: text,
        encoding_format: "float",
    });
    return embedding.data[0].embedding;
}

const insertIntoDB = async ({ embedding, url, body, head }) => {
    const collection = await chromaClient.getOrCreateCollection({
        name: WEB_COLLECTION,
    });

    await collection.add({
        ids: [url],
        embeddings: [embedding],
        metadatas: [{ url, body, head }]
    })
}

const ingest = async (url = "") => {
    console.log("Ingesting started");
    const { head, body, internalLinks } = await scrapeWebPage(url);
    // const headEmbeddings = await generateVectorEmbeddings(head);
    const bodyChunks = chunkText(body, 1000);
    for (let chunk of bodyChunks) {
        const bodyEmbeddings = await generateVectorEmbeddings({ text: chunk });
        await insertIntoDB({
            embedding: bodyEmbeddings,
            url,
            body,
            head
        })
    }
    // for (let link of internalLinks) {
    //     let _url = `${url}${link}`;
    //     console.log(_url);
    //     await ingest(_url);
    // }
    console.log("Ingesting End");
}

// ingest("https://advy.me");
// ingest("https://blog.advy.me");
// ingest("http://app.advy.me");

async function chat(question) {
    const questionEmbedding = await generateVectorEmbeddings({ text: question });
    const collection = await chromaClient.getOrCreateCollection({
        name: WEB_COLLECTION,
    });

    const collectionResult = await collection.query({
        nResults: 3,
        queryEmbeddings: questionEmbedding,
    });

    const body = collectionResult.metadatas[0].map((e) => e.body).filter((e) => e.trim() !== "" && !!e);
    const url = collectionResult.metadatas[0].map((e) => e.url).filter((e) => e.trim() !== "" && !!e);

    const response = await openai.chat.completions.create({
        model: "gemini-2.0-flash",
        messages: [
            { role: "system", content: "You are an AI support agent expert in providing support to users on behalf of a webpage. Given the context about page content , reply the user accordingly." },
            {
                role: "user",
                content: `
                    Query : ${question}\n\n
                    URLs : ${url.join(", ")}
                    Retrieved Context : ${body.join(", ")}
                `
            }
        ],
    })
    console.log(`Bot : ${response.choices[0].message.content}`);
}

chat("how to create qr ? ")

function chunkText(text, chunkSize) {
    if (!text || chunkSize <= 0) return [];

    const words = text.split(/\s+/);
    const chunks = [];
    for (let i = 0; i < words.length; i += chunkSize) {
        chunks.push(words.slice(i, i + chunkSize).join(" "));
    }
    return chunks;
}