import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Instagram DM Agent",
  description: "AI-powered Instagram DM dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="h-screen overflow-hidden bg-[#0f0f0f] text-white" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
