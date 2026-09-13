import { describe, expect, it } from "vitest";

import { parseToolResultImages } from "@/shared/lib/schemas";

/**
 * Recognising an image tool result.
 *
 * A tool that returns an image hands back content blocks. The agents service
 * replaces the original base64 with a bounded thumbnail before emitting — the
 * model keeps the full image — so what the client sees is `preview_base64` plus
 * the original size, or `omitted` when it could not be shrunk.
 *
 * Getting this wrong is not subtle in one direction and invisible in the other:
 * a false negative shows a wall of JSON where a picture belongs, and a false
 * positive hides a real result behind a broken image. Both are worse than the
 * plain JSON fallback, so the parser is strict and silent about anything it
 * does not recognise.
 */

const image = (over: Record<string, unknown> = {}) => ({
  type: "image",
  mime_type: "image/jpeg",
  preview_base64: "AAAA",
  bytes: 184320,
  omitted: false,
  ...over,
});

describe("recognising images", () => {
  it("parses a serialised block list", () => {
    const parsed = parseToolResultImages(JSON.stringify([image()]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].preview_base64).toBe("AAAA");
    expect(parsed[0].bytes).toBe(184320);
  });

  it("parses an already-decoded block list", () => {
    expect(parseToolResultImages([image()])).toHaveLength(1);
  });

  it("keeps every image in a multi-image result", () => {
    const parsed = parseToolResultImages(JSON.stringify([image(), image(), image()]));
    expect(parsed).toHaveLength(3);
  });

  it("picks the image out of a mixed text and image result", () => {
    const parsed = parseToolResultImages(
      JSON.stringify([{ type: "text", text: "here it is" }, image()]),
    );
    expect(parsed).toHaveLength(1);
  });

  it("carries an omitted image through so the reason can be shown", () => {
    // Dropping it would render nothing at all, which reads as a broken tool
    // rather than an image that was too large.
    const parsed = parseToolResultImages(
      JSON.stringify([image({ omitted: true, preview_base64: undefined })]),
    );
    expect(parsed[0].omitted).toBe(true);
    expect(parsed[0].preview_base64).toBeUndefined();
  });
});

describe("everything else falls back to JSON", () => {
  it.each([
    ["plain text", "the file says hello"],
    ["an empty string", ""],
    ["malformed JSON", '[{"type": "image"'],
    ["an object rather than a list", JSON.stringify(image())],
    ["a text-only block list", JSON.stringify([{ type: "text", text: "hi" }])],
    ["an empty list", "[]"],
    ["null", null],
    ["a number", 42],
  ])("returns nothing for %s", (_label, output) => {
    expect(parseToolResultImages(output)).toEqual([]);
  });

  it("ignores a block that only looks like an image", () => {
    // `type` is the discriminator; a stray mime_type must not promote a text
    // block into a broken <img>.
    expect(
      parseToolResultImages(JSON.stringify([{ type: "text", mime_type: "image/png" }])),
    ).toEqual([]);
  });

  it("never throws on hostile input", () => {
    // Tool results are semi-trusted content parsed during a message render.
    expect(() => parseToolResultImages('[{"type":"image","bytes":"lots"}]')).not.toThrow();
    expect(() => parseToolResultImages({ nested: { deeply: true } })).not.toThrow();
  });
});

describe("defaults", () => {
  it("falls back to image/png when the mime type is missing", () => {
    const parsed = parseToolResultImages(
      JSON.stringify([{ type: "image", preview_base64: "AAAA" }]),
    );
    expect(parsed[0].mime_type).toBe("image/png");
    expect(parsed[0].omitted).toBe(false);
  });
});
