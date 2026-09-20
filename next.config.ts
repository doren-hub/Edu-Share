import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdf-parse"],
  experimental: {
    /** PDF など大きな multipart を Route Handler で受けるため（既定は小さめで FormData 解析が失敗することがある） */
    serverActions: {
      bodySizeLimit: "200mb",
    },
    /** ミドルウェアを通るリクエストのボディ上限（NotebookLM の MP4 は 50MB を超えることがある） */
    middlewareClientMaxBodySize: "200mb",
  },
};

export default nextConfig;
