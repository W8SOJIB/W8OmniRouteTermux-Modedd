import type { RegistryEntry } from "../../shared.ts";

export const chatgpt_webProvider: RegistryEntry = {
  id: "chatgpt-web",
  alias: "cgpt-web",
  format: "openai",
  executor: "chatgpt-web",
  baseUrl: "https://chatgpt.com/backend-api/conversation",
  authType: "apikey",
  authHeader: "cookie",
  models: [
    {
      id: "gpt-5.6-sol-pro",
      name: "GPT-5.6 Sol (Pro)",
      liveCatalogIds: ["gpt-5-6-pro"],
      toolCalling: false,
    },
    {
      id: "gpt-5.6-sol-xhigh",
      name: "GPT-5.6 Sol (Xhigh)",
      liveCatalogIds: ["gpt-5-6-thinking"],
      toolCalling: false,
    },
    {
      id: "gpt-5.6-sol-high",
      name: "GPT-5.6 Sol (High)",
      liveCatalogIds: ["gpt-5-6-thinking"],
      toolCalling: false,
    },
    {
      id: "gpt-5.6-sol-medium",
      name: "GPT-5.6 Sol (Medium)",
      liveCatalogIds: ["gpt-5-6-thinking"],
      toolCalling: false,
    },
    {
      id: "gpt-5.6-sol-instant",
      name: "GPT-5.6 Sol (Instant)",
      liveCatalogIds: ["gpt-5-6"],
      toolCalling: false,
    },
    {
      id: "gpt-5.6-luna-free-thinking",
      name: "GPT-5.6 Luna (Free, Think)",
      liveCatalogIds: ["gpt-5-6"],
      toolCalling: false,
    },
    {
      id: "gpt-5.6-luna-free",
      name: "GPT-5.6 Luna (Free)",
      liveCatalogIds: ["gpt-5-6"],
      toolCalling: false,
    },
    {
      id: "gpt-5.5-pro-extended",
      name: "GPT-5.5 (Pro Extended)",
      liveCatalogIds: ["gpt-5-5-pro"],
      toolCalling: false,
    },
    {
      id: "gpt-5.5-pro",
      name: "GPT-5.5 (Pro)",
      liveCatalogIds: ["gpt-5-5-pro"],
      toolCalling: false,
    },
    {
      id: "gpt-5.5-xhigh",
      name: "GPT-5.5 (Xhigh)",
      liveCatalogIds: ["gpt-5-5-thinking"],
      toolCalling: false,
    },
    {
      id: "gpt-5.5-high",
      name: "GPT-5.5 (High)",
      liveCatalogIds: ["gpt-5-5-thinking"],
      toolCalling: false,
    },
    {
      id: "gpt-5.5-medium",
      name: "GPT-5.5 (Medium)",
      liveCatalogIds: ["gpt-5-5-thinking"],
      toolCalling: false,
    },
    {
      id: "gpt-5.5-instant",
      name: "GPT-5.5 (Instant)",
      liveCatalogIds: ["gpt-5-5"],
      toolCalling: false,
    },
  ],
};
