import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  preview: {
    port: process.env.PORT ? Number(process.env.PORT) : 4173,
    host: true,
    allowedHosts: true,
  },
});
