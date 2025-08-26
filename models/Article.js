import mongoose from "mongoose";

const ArticleSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    summary: String,
    body: String,
    lang: { type: String, default: "te" },
    region: { type: String, default: "AP" },
    source: String,
    imageUrl: String,
    media: { type: [String], default: [] },
    publishedAt: { type: Date, required: true },
    url: { type: String, unique: true },
    categories: { type: Map, of: Number, default: {} },
    topCategory: String,
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

export default mongoose.model("Article", ArticleSchema);
