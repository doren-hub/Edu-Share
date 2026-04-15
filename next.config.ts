import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdf-parse"],
  experimental: {
    /** PDF など大きな multipart を Route Handler で受けるため（既定は小さめで FormData 解析が失敗することがある） */
    serverActions: {
      bodySizeLimit: "50mb",
    },
    /** ミドルウェアを通るリクエストのボディ上限（アップロード API 用） */
    middlewareClientMaxBodySize: "50mb",
  },
};

export default nextConfig;
