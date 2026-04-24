"use client";

import Image from "next/image";
import { useState } from "react";

type AvatarProps = {
  src: string | null;
  name: string | null;
  username: string | null;
  size?: number;
};

export default function Avatar({ src, name, username, size = 40 }: AvatarProps) {
  const [imgError, setImgError] = useState(false);

  const initials = name
    ? name
        .split(" ")
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : (username?.[0] ?? "?").toUpperCase();

  const showImage = src && !imgError;

  return (
    <div
      className="rounded-full flex-shrink-0 relative overflow-hidden"
      style={{ width: size, height: size }}
    >
      {showImage ? (
        <Image
          src={src}
          alt={name ?? username ?? "User"}
          width={size}
          height={size}
          className="object-cover w-full h-full"
          onError={() => setImgError(true)}
          unoptimized
        />
      ) : (
        <div
          className="w-full h-full flex items-center justify-center text-white font-semibold bg-gradient-to-br from-purple-500 to-pink-500"
          style={{ fontSize: size * 0.4 }}
        >
          {initials}
        </div>
      )}
    </div>
  );
}
