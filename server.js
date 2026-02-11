import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import pkg from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const { TelegramClient, Api } = pkg;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const apiId = Number(process.env.API_ID) || 38074028;
const apiHash = process.env.API_HASH || "db286568b5fee52eb8543f8ab8825a6f";

let activeClients = {};

app.get("/health", (req, res) => res.send("OK"));

// Helper to create client with HTTPS preference
function createClient(sessionString = "") {
    return new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
        connectionRetries: 5,
        requestRetries: 3,
        retryDelay: 2000,
        autoReconnect: true,
        dc: 2,                    // Force stable HTTPS DC
        testServers: false
    });
}

// 1. Send Code
app.post("/api/send-code", async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone?.trim()) return res.status(400).json({ error: "Phone required" });

        const cleanPhone = phone.trim().replace(/\s+/g, '');
        const client = createClient();

        await client.connect();
        activeClients[cleanPhone] = client;

        await client.sendCode({ apiId, apiHash }, cleanPhone);
        res.json({ success: true, message: "Code sent" });
    } catch (e) {
        console.error("[send-code error]", e.message);
        res.status(500).json({ error: e.message || "Failed to send code" });
    }
});

// 2. Verify & Get Session
app.post("/api/verify", async (req, res) => {
    try {
        const { phone, code, password } = req.body;
        if (!phone?.trim() || !code?.trim()) {
            return res.status(400).json({ error: "Phone and code required" });
        }

        const cleanPhone = phone.trim().replace(/\s+/g, '');
        const client = activeClients[cleanPhone];
        if (!client) return res.status(400).json({ error: "No active login session" });

        await client.start({
            phoneNumber: async () => cleanPhone,
            phoneCode: async () => code.trim(),
            password: password?.trim() ? async () => password.trim() : undefined,
            onError: (err) => { throw err; }
        });

        const session = client.session.save();
        delete activeClients[cleanPhone];

        res.json({ success: true, session });
    } catch (e) {
        console.error("[verify error]", e.message);
        res.status(500).json({ error: e.message || "Login failed" });
    }
});

// 3. Scrape ONLY open public supergroups
app.post("/api/scrape", async (req, res) => {
    res.json({ success: true, message: "Started — searching open supergroups" });

    const { session, keywords, maxGroups = 80 } = req.body;

    if (!session || !Array.isArray(keywords) || keywords.length === 0) {
        io.emit("scrape-error", { message: "Missing session or keywords" });
        return;
    }

    const client = createClient(session);

    try {
        await client.connect();

        if (!(await client.checkAuthorization())) {
            io.emit("scrape-error", { message: "Invalid or expired session" });
            return;
        }

        const foundUsernames = new Set();
        let count = 0;
        const target = Math.min(500, Math.max(10, Number(maxGroups)));

        const suffixVariations = [
            "", "group", "chat", "discussion", "community", "talk", "kenya",
            "friends", "support", "help", "meet", "connect", "hub", "circle"
        ];

        outer: for (const baseKeyword of keywords) {
            for (const suffix of suffixVariations) {
                const query = `${baseKeyword.trim()} ${suffix}`.trim();
                if (!query) continue;

                let searchResult;
                try {
                    searchResult = await client.invoke(
                        new Api.contacts.Search({ q: query, limit: 70 })
                    );
                } catch (err) {
                    if (err.errorMessage?.includes("FLOOD_WAIT")) {
                        console.warn(`[flood wait] Pausing 30s for query: ${query}`);
                        await new Promise(r => setTimeout(r, 30000));
                        continue;
                    }
                    console.warn(`[search failed] "${query}":`, err.message);
                    continue;
                }

                for (const chat of searchResult.chats) {
                    if (count >= target) break outer;

                    if (
                        !chat.username ||
                        foundUsernames.has(chat.username) ||
                        !chat.megagroup ||
                        chat.broadcast ||
                        chat.className !== "Channel"
                    ) {
                        continue;
                    }

                    foundUsernames.add(chat.username);
                    const link = `https://t.me/${chat.username}`;

                    try {
                        const fullInfo = await client.invoke(
                            new Api.channels.GetFullChannel({ channel: chat })
                        );

                        const memberCount = fullInfo.fullChat.participantsCount || 0;
                        if (memberCount < 50) continue;

                        io.emit("group-found", {
                            title: chat.title || "Unnamed Group",
                            link,
                            members: memberCount,
                            type: "Open Supergroup",
                            username: chat.username,
                            foundAt: new Date().toISOString()
                        });

                        count++;
                    } catch (e) {
                        // skip inaccessible
                    }

                    await new Promise(r => setTimeout(r, 500));
                }

                await new Promise(r => setTimeout(r, 2200));
            }
        }

        io.emit("scrape-complete", { found: count, target });
        console.log(`[scrape done] Discovered ${count} open supergroups`);
    } catch (err) {
        console.error("[scrape crashed]", err.message);
        io.emit("scrape-error", { message: "Crawl failed — " + err.message });
    }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT} (Render assigned: ${process.env.PORT || "not set"})`);
});