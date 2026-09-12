import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["imapflow", "nodemailer"],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
