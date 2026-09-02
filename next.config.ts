import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Statyczny eksport pod Netlify (ręczny deploy zip/drag-and-drop) — appka
  // jest w pełni client-side (Supabase JS SDK, klucz publishable), tak samo
  // jak appka floty tego samego klienta (dist/*.html wgrywane na Netlify).
  output: "export",
};

export default nextConfig;
