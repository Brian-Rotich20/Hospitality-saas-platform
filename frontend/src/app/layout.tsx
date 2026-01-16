import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Header from "./components/layout/Header";
import Footer from "./components/layout/Footer";
import BottomNav from './components/layout/BottomNav';
const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Hospitality Marketplace - Find & Book Perfect Venues in Kenya",
  description: "Discover and book event venues, catering services, and accommodations across Kenya. Secure payments via M-Pesa.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <Header />
        <main className="min-h-screen">{children}</main>
        <Footer />
        <BottomNav />
      </body>
    </html>
  );
}