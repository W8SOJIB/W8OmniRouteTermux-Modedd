/**
 * @file index.ts
 * @description Raycast Pro AI provider registry entry (reverse-engineered, unofficial API).
 *
 * @changes
 * - [2026-07-28] [Composer] - Initial Raycast provider registry module
 */

import type { RegistryEntry } from "../../shared.ts";

/** Seed catalog — full list synced from Raycast /api/v1/ai/models on connect/import. */
export const raycastProvider: RegistryEntry = {
  id: "raycast",
  alias: "rc",
  format: "openai",
  executor: "raycast",
  baseUrl: "https://backend.raycast.com/api/v1/ai",
  authType: "oauth",
  authHeader: "bearer",
  defaultContextLength: 128000,
  models: [
    //GPT
    { id: "openai-gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { id: "openai-gpt-5.6-terra", name: "GPT-5.6 Terra" },
    { id: "openai-gpt-5.6-luna", name: "GPT-5.6 Luna" },
    //Claude
    { id: "anthropic-claude-opus-5", name: "Claude Opus 5" },
    { id: "anthropic-claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "anthropic-claude-4-5-haiku-reasoning", name: "Claude 4.5 Haiku Reasoning" },
    { id: "anthropic-claude-4-5-haiku", name: "Claude 4.5 Haiku" },
    //Gemini
    { id: "google-gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    { id: "google-gemini-3.7-flash", name: "Gemini 3.7 Flash" },
    { id: "google-gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite" },
    //Perplexity
    { id: "perplexity-sonar-reasoning-pro", name: "Sonar Reasoning Pro" },
    { id: "perplexity-sonar-pro", name: "Sonar Pro" },
    { id: "perplexity-sonar", name: "Sonar" },
    //Mistral
    { id: "mistral-mistral-large-latest", name: "Mistral Large" },
    { id: "mistral-mistral-medium-latest", name: "Mistral Medium" },
    { id: "mistral-mistral-small-latest", name: "Mistral Small" },
    { id: "mistral-codestral-latest", name: "Codestral" },
    { id: "mistral-open-mistral-nemo", name: "Mistral Nemo" },
    //Grok
    { id: "xai-grok-4.6", name: "Grok 4.6" },
    //Opensource
    { id: "gateway-alibaba/qwen3.8-max", name: "Qwen 3.8 Max" },
    { id: "gateway-moonshotai/kimi-k3", name: "Kimi K3" },
    { id: "baseten-deepseek-ai/DeepSeek-V4-Pro", name: "DeepSeek V4 Pro" },
    { id: "gateway-deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "baseten-zai-org/GLM-5.2", name: "GLM 5.2" },
    { id: "gateway-thinkingmachines/inkling-1.0", name: "Inkling 1.0" },
    { id: "gateway-google/gemma-4-31b-it", name: "Gemma 4 31B" },
    { id: "groq-openai/gpt-oss-120b", name: "GPT-OSS 120B" },
    { id: "groq-openai/gpt-oss-20b", name: "GPT-OSS 20B" },
    { id: "groq-qwen/qwen3-32b", name: "Qwen 3 32B" },
    { id: "groq-llama-3.3-70b-versatile", name: "LLaMA 3.3 70B" },
    { id: "groq-llama-3.1-8b-instant", name: "LLaMA 3.1 8B" },
  ],
};
