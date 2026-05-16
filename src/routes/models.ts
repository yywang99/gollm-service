import { FastifyInstance } from "fastify";

export async function modelsRoute(fastify: FastifyInstance) {
  fastify.get("/v1/models", async () => {
    return {
      object: "list",
      data: [
        {
          id: "gemini-fast",
          object: "model",
          created: 1700000000,
          owned_by: "google/gemini",
          permission: [],
          root: "gemini-fast",
          parent: null,
        },
        {
          id: "gemini-think",
          object: "model",
          created: 1700000001,
          owned_by: "google/gemini",
          permission: [],
          root: "gemini-think",
          parent: null,
        },
        {
          id: "gemini-pro",
          object: "model",
          created: 1700000002,
          owned_by: "google/gemini",
          permission: [],
          root: "gemini-pro",
          parent: null,
        },
      ],
    };
  });
}