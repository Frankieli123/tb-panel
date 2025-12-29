import { Page, ElementHandle } from 'playwright';

function randomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomRange(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export class HumanSimulator {
  private lastMouseX: number = 0;
  private lastMouseY: number = 0;

  constructor(private page: Page) {}

  async navigateAsHuman(url: string): Promise<void> {
    await this.sleep(randomDelay(500, 1200));

    await this.page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    await this.sleep(randomDelay(800, 2000));
  }

  async browsePage(options: {
    scrollDown: boolean;
    viewImages: boolean;
    duration: number;
  }): Promise<void> {
    const startTime = Date.now();

    if (options.scrollDown) {
      const scrollSteps = randomRange(2, 5);
      for (let i = 0; i < scrollSteps; i++) {
        const distance = randomRange(300, 800);
        await this.smoothScroll(distance);
        await this.sleep(randomDelay(400, 900));

        if (Date.now() - startTime > options.duration) break;
      }
    }

    if (options.viewImages) {
      const images = await this.page.$$('.main-img, .product-img, img[class*="mainPic"]');
      if (images.length > 0) {
        const randomImg = images[randomRange(0, Math.min(images.length - 1, 2))];
        await this.moveToElement(randomImg);
        await this.sleep(randomDelay(300, 700));
      }
    }

    const elapsed = Date.now() - startTime;
    if (elapsed < options.duration) {
      await this.sleep(options.duration - elapsed);
    }
  }

  async moveToElement(elementOrSelector: ElementHandle | string): Promise<void> {
    const element = typeof elementOrSelector === 'string'
      ? await this.page.$(elementOrSelector)
      : elementOrSelector;

    if (!element) return;

    const box = await element.boundingBox();
    if (!box) return;

    const targetX = box.x + box.width / 2 + randomRange(-10, 10);
    const targetY = box.y + box.height / 2 + randomRange(-5, 5);

    await this.bezierMouseMove(targetX, targetY);
  }

  async clickElement(selector: string): Promise<boolean> {
    try {
      await this.scrollToElement(selector);

      await this.moveToElement(selector);

      await this.sleep(randomDelay(200, 500));

      await this.page.click(selector);

      return true;
    } catch (error) {
      console.error(`[HumanSimulator] Click failed: ${selector}`, error);
      return false;
    }
  }

  async scrollToElement(selector: string): Promise<void> {
    await this.page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, selector);

    await this.sleep(randomDelay(400, 800));
  }

  async smoothScroll(distance: number): Promise<void> {
    const steps = Math.ceil(distance / 20);
    for (let i = 0; i < steps; i++) {
      await this.page.mouse.wheel(0, 20);  // deltaX=0, deltaY=20
      await this.sleep(randomDelay(10, 30));
    }
  }

  async randomScroll(options: { distance: number }): Promise<void> {
    await this.smoothScroll(options.distance);
  }

  private async bezierMouseMove(targetX: number, targetY: number): Promise<void> {
    const currentX = this.lastMouseX;
    const currentY = this.lastMouseY;

    const cp1x = currentX + (targetX - currentX) * 0.3 + randomRange(-50, 50);
    const cp1y = currentY + (targetY - currentY) * 0.3 + randomRange(-50, 50);
    const cp2x = currentX + (targetX - currentX) * 0.7 + randomRange(-50, 50);
    const cp2y = currentY + (targetY - currentY) * 0.7 + randomRange(-50, 50);

    const steps = 20;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = this.cubicBezier(currentX, cp1x, cp2x, targetX, t);
      const y = this.cubicBezier(currentY, cp1y, cp2y, targetY, t);

      await this.page.mouse.move(x, y);
      await this.sleep(randomDelay(8, 20));

      this.lastMouseX = x;
      this.lastMouseY = y;
    }
  }

  private cubicBezier(p0: number, p1: number, p2: number, p3: number, t: number): number {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
  }

  async sleep(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  async occasionalWander(): Promise<void> {
    if (Math.random() < 0.15) {
      const randomX = randomRange(100, 800);
      const randomY = randomRange(100, 600);
      await this.bezierMouseMove(randomX, randomY);
      await this.sleep(randomDelay(300, 600));
    }
  }
}

export { randomDelay, randomRange };
