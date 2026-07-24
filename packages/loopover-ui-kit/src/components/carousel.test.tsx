import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock Embla so we can assert the keyboard handler calls scrollPrev/scrollNext (#8308) without a real
// carousel engine. useEmblaCarousel returns [refCallback, api]; the api only needs the members Carousel
// touches (scroll + canScroll + the reInit/select event wiring in its effects).
const scrollPrev = vi.fn();
const scrollNext = vi.fn();
const mockApi = {
  scrollPrev,
  scrollNext,
  canScrollPrev: () => true,
  canScrollNext: () => true,
  on: vi.fn(),
  off: vi.fn(),
};
vi.mock("embla-carousel-react", () => ({
  default: () => [() => {}, mockApi],
}));

import { Carousel, CarouselContent, CarouselItem } from "./carousel";

function renderCarousel(orientation: "horizontal" | "vertical") {
  return render(
    <Carousel orientation={orientation}>
      <CarouselContent>
        <CarouselItem>one</CarouselItem>
        <CarouselItem>two</CarouselItem>
      </CarouselContent>
    </Carousel>,
  );
}

afterEach(() => {
  scrollPrev.mockClear();
  scrollNext.mockClear();
});

describe("Carousel keyboard navigation is orientation-aware (#8308)", () => {
  it("horizontal (default): ArrowLeft -> scrollPrev, ArrowRight -> scrollNext", () => {
    renderCarousel("horizontal");
    const region = screen.getByRole("region");
    fireEvent.keyDown(region, { key: "ArrowLeft" });
    expect(scrollPrev).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(region, { key: "ArrowRight" });
    expect(scrollNext).toHaveBeenCalledTimes(1);
  });

  it("horizontal: ArrowUp/ArrowDown do NOT scroll", () => {
    renderCarousel("horizontal");
    const region = screen.getByRole("region");
    fireEvent.keyDown(region, { key: "ArrowUp" });
    fireEvent.keyDown(region, { key: "ArrowDown" });
    expect(scrollPrev).not.toHaveBeenCalled();
    expect(scrollNext).not.toHaveBeenCalled();
  });

  it("vertical: ArrowUp -> scrollPrev, ArrowDown -> scrollNext", () => {
    renderCarousel("vertical");
    const region = screen.getByRole("region");
    fireEvent.keyDown(region, { key: "ArrowUp" });
    expect(scrollPrev).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(region, { key: "ArrowDown" });
    expect(scrollNext).toHaveBeenCalledTimes(1);
  });

  it("vertical: ArrowLeft/ArrowRight (no on-screen meaning in this layout) do NOT scroll", () => {
    renderCarousel("vertical");
    const region = screen.getByRole("region");
    fireEvent.keyDown(region, { key: "ArrowLeft" });
    fireEvent.keyDown(region, { key: "ArrowRight" });
    expect(scrollPrev).not.toHaveBeenCalled();
    expect(scrollNext).not.toHaveBeenCalled();
  });
});
