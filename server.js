// server.js

// 1. Import necessary packages
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import 'dotenv/config'; // To load environment variables from a .env file

// --- Mongoose Schema Definition ---
const ArticleSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    summary: String,
    body: String,
    lang: { type: String, default: "te" }, // "te" | "en" | "mixed"
    region: { type: String, default: "AP" }, // AP | TS | India | Intl
    source: String,
    imageUrl: String,
    publishedAt: { type: Date, required: true },
    url: String,
    // NLP outputs
    categories: { type: Map, of: Number, default: {} }, // {politics:0.92,...}
    topCategory: String,
    // Lightweight content vector (categories -> fixed order)
    vecContent: { type: [Number], default: [] },
    blocked: { type: Boolean, default: false },
    boost: { type: Map, of: Number, default: {} },
  },
  { timestamps: true }
);

ArticleSchema.index({ publishedAt: -1 });
ArticleSchema.index({ topCategory: 1 });
ArticleSchema.index({ region: 1 });
ArticleSchema.index({ blocked: 1 });

const Article = mongoose.model("Article", ArticleSchema);
// --- End of Schema ---


// 2. Initialize Express app
const app = express();
const port = process.env.PORT || 8000;

// --- Connect to MongoDB ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected successfully."))
  .catch(err => console.error("MongoDB connection error:", err));


// 3. Set up middleware
app.use(cors());
app.use(express.json());

// 4. Define API endpoints

// --- POST /api/generate - Generate and Save a New Article ---
app.post('/api/generate', async (req, res) => {
    // Expect a 'prompt' field which contains the user's full instruction.
    const { prompt } = req.body;

    // --- Validate Input ---
    if (!prompt) {
        return res.status(400).json({ error: 'A "prompt" is required in the request body' });
    }

    // --- Prepare the request for the Gemini API ---
    const apiKey = process.env.GEMINI_API_KEY;
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    // **MODIFIED PROMPT**: Now asks for a JSON object while still enforcing word count.
    const wrapperPrompt = `
        You are a text processing bot. Your only function is to follow the user's command exactly as written.
        User command: "${prompt}"

        Your response MUST follow these rules:
        1. The output must be a single, minified JSON object with two keys: "title" and "body".
        2. The value of the "body" key must be EXACTLY the word count specified by the user. Not one word more.
        3. Do not add any introductory phrases, explanations, or markdown formatting like \`\`\`json.
        4. Only use information from the provided text in the user command.
        This is a strict word count and JSON format task.
    `;

    // The payload structure for the Gemini API
    const requestBody = {
        contents: [
            {
                parts: [
                    {
                        // Use the new, more forceful wrapper prompt
                        text: wrapperPrompt
                    }
                ]
            }
        ]
    };

    try {
        // --- Make the API Call using fetch ---
        const apiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
        });

        if (!apiResponse.ok) {
            const errorBody = await apiResponse.text();
            console.error("Gemini API Error:", errorBody);
            throw new Error(`Gemini API request failed with status ${apiResponse.status}`);
        }

        const data = await apiResponse.json();

        // --- Extract and Parse the Generated JSON ---
        const generatedText = data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (generatedText === undefined) {
            console.error("Unexpected API response structure:", data);
            throw new Error("Could not extract generated text from the API response.");
        }

        try {
            // The AI should return a JSON string. We parse it into a JavaScript object.
            const articleObject = JSON.parse(generatedText);

            // --- Save to MongoDB ---
            const newArticle = new Article({
                title: articleObject.title,
                body: articleObject.body,
                publishedAt: new Date() // Set the publication date to now
            });
            const savedArticle = await newArticle.save();
            console.log("Article saved to DB:", savedArticle._id);

            // --- Send the Saved Article as the Response ---
            res.status(201).json(savedArticle);

        } catch (parseOrDbError) {
            console.error("Error parsing JSON or saving to DB:", parseOrDbError);
            console.error("Received text from Gemini:", generatedText); // Log what we received
            res.status(500).json({ error: 'Failed to parse the response or save the article.' });
        }

    } catch (error) {
        console.error('Error calling Gemini API:', error);
        res.status(500).json({ error: 'Failed to generate content from the API.' });
    }
});

// --- GET /api/articles - Fetch Saved Articles ---
app.get('/api/articles', async (req, res) => {
    try {
        // Pagination: get page and limit from query params, with defaults
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        // Fetch articles from the database
        const articles = await Article.find()
            .sort({ publishedAt: -1 }) // Sort by newest first
            .skip(skip)
            .limit(limit);

        // Get total number of articles for pagination metadata
        const totalArticles = await Article.countDocuments();

        // Send response with articles and pagination info
        res.status(200).json({
            articles,
            currentPage: page,
            totalPages: Math.ceil(totalArticles / limit),
            totalArticles
        });

    } catch (error) {
        console.error("Error fetching articles:", error);
        res.status(500).json({ error: 'Failed to fetch articles from the database.' });
    }
});


// 5. Start the server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});

/*
-- How to set up and run this server --

1.  Create a new directory for your backend project:
    mkdir gemini-direct-server
    cd gemini-direct-server

2.  Initialize a new Node.js project:
    npm init -y

3.  Install the required dependencies:
    npm install express cors dotenv mongoose

4.  In the generated package.json, add the following line to enable ES Modules:
    "type": "module",

5.  Create a file named 'server.js' and paste the code above into it.

6.  Create a file named '.env' in the same directory and add your API key AND your MongoDB connection string:
    GEMINI_API_KEY="YOUR_GOOGLE_AI_STUDIO_API_KEY"
    MONGO_URI="YOUR_MONGODB_CONNECTION_STRING"

7.  Run the server from your terminal:
    node server.js

    Your backend will now generate the article, save it to MongoDB, and return the saved document.
*/
