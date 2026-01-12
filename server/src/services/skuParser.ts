import { Page } from 'playwright';

export interface SkuProperty {
  propId: string;
  propName: string;
  values: Array<{
    valueId: string;
    valueName: string;
    imageUrl?: string;
    disabled?: boolean;
  }>;
}

export interface SkuCombination {
  skuId: string;
  skuKey: string;
  properties: string;
  selections: Array<{
    propId: string;
    propName: string;
    valueId: string;
    valueName: string;
  }>;
  price?: number;
  originalPrice?: number;
  stock: number;
  imageUrl?: string;
}

export interface SkuTree {
  properties: SkuProperty[];
  combinations: SkuCombination[];
  totalCount: number;
}

export class SkuParser {
  constructor(private page: Page) {}

  async parseSkuTree(taobaoId: string): Promise<SkuTree> {
    console.log(`[SkuParser] 开始解析 taobaoId=${taobaoId}`);

    const skuData = await this.extractSkuData();

    if (!skuData || !skuData.properties || skuData.properties.length === 0) {
      console.log(`[SkuParser] 未找到 SKU 属性，视为单 SKU 商品`);
      return this.createSingleSkuTree(taobaoId);
    }

    const properties = this.parseProperties(skuData.properties);
    const combinations = this.generateCombinations(properties, skuData.skus);

    console.log(`[SkuParser] 找到 ${combinations.length} 个 SKU 组合`);

    return {
      properties,
      combinations,
      totalCount: combinations.length
    };
  }

  private async extractSkuData(): Promise<any> {
    // 尝试从DOM直接提取SKU选项（天猫/淘宝新版页面）
    const domSkuData = await this.page.evaluate(() => {
      const skuPanel = document.querySelector('[id*="SkuPanel"]');
      if (!skuPanel) return null;

      const normalizeText = (s: any) => String(s ?? '').replace(/\s+/g, ' ').trim();

      const containerSelectors = [
        '[class*="propItem"]',
        '[class*="Property"]',
        '[class*="skuItem"]',
        '[class*="skuLine"]',
      ];

      let containers = Array.from(skuPanel.querySelectorAll(containerSelectors.join(',')))
        .filter((el) => el.querySelector('[data-vid]'));

      // 兜底：如果找不到明显的分组容器，则按每个 data-vid 的最近可分组祖先聚合
      if (containers.length === 0) {
        const items = Array.from(skuPanel.querySelectorAll('[data-vid]'));
        const set = new Set<Element>();
        for (const item of items) {
          const c =
            item.closest('[class*="propItem"]') ||
            item.closest('[class*="Property"]') ||
            item.closest('dl') ||
            item.parentElement;
          if (c && c instanceof Element) set.add(c);
        }
        containers = Array.from(set).filter((el) => el.querySelector('[data-vid]'));
      }

      const properties: any[] = [];

      containers.forEach((container, idx) => {
        const labelEl =
          container.querySelector('[class*="propName"]') ||
          container.querySelector('[class*="name"]') ||
          container.querySelector('dt') ||
          container.querySelector('label');

        let propName = normalizeText(labelEl?.textContent);
        if (!propName || propName.length > 40) {
          propName = `规格${idx + 1}`;
        }

        const valueNodes = Array.from(container.querySelectorAll('[data-vid]'));
        const values: any[] = [];

        for (const node of valueNodes) {
          const vid = (node as any).getAttribute?.('data-vid');
          if (!vid) continue;

          const isDisabledAttr = (node as any).getAttribute?.('data-disabled') === 'true';
          const className = String((node as any).getAttribute?.('class') || '');
          const isDisabledClass = /disabled|invalid|soldout|out/i.test(className);
          const disabled = Boolean(isDisabledAttr || isDisabledClass);

          let valueName =
            normalizeText((node as any).getAttribute?.('title')) ||
            normalizeText((node as any).textContent);
          if (!valueName) {
            const img = (node as any).querySelector?.('img');
            valueName = normalizeText(img?.getAttribute?.('alt')) || normalizeText(img?.getAttribute?.('title'));
          }

          const imgEl = (node as any).querySelector?.('img');
          const imageUrl = imgEl?.getAttribute?.('src') || imgEl?.src || undefined;

          if (!valueName) continue;
          if (values.find((v) => v.valueId === String(vid))) continue;

          values.push({
            valueId: String(vid),
            valueName,
            imageUrl,
            disabled,
          });
        }

        if (values.length > 0) {
          properties.push({
            propId: `prop_${idx + 1}`,
            propName,
            values,
          });
        }
      });

      if (properties.length === 0) return null;

      return { properties, source: 'dom' };
    });

    if (domSkuData && domSkuData.properties && domSkuData.properties.length > 0) {
      console.log(`[SkuParser] 从 DOM 提取到 ${domSkuData.properties.length} 个规格维度`);
      return domSkuData;
    }

    // 降级：尝试从window全局变量提取
    const skuData = await this.page.evaluate(() => {
      const win = window as any;

      const candidates = [
        win.g_config?.skuData,
        win.__INITIAL_STATE__?.skuBase,
        win.TB?.detail?.data?.skuBase,
        win.g_config?.sku,
      ];

      for (const candidate of candidates) {
        if (candidate && candidate.properties) {
          return candidate;
        }
      }

      const scriptTags = Array.from(document.querySelectorAll('script'));
      for (const script of scriptTags) {
        const content = script.textContent || '';
        if (content.includes('skuBase') || content.includes('skuData')) {
          const match = content.match(/skuBase["\s:]+({[\s\S]*?})\s*[,;]/);
          if (match) {
            try {
              return JSON.parse(match[1]);
            } catch (e) {
              continue;
            }
          }
        }
      }

      return null;
    });

    return skuData;
  }

  private parseProperties(rawProperties: any[]): SkuProperty[] {
    return rawProperties.map(prop => ({
      propId: String(prop.pid || prop.propertyId || prop.id || prop.propId || prop.name || prop.propertyName),
      propName: prop.name || prop.propertyName || prop.propName || '属性',
      values: (prop.values || []).map((val: any) => ({
        valueId: String(val.vid || val.valueId || val.id),
        valueName: val.name || val.valueName || '',
        imageUrl: val.image || val.imageUrl,
        disabled: Boolean(val.disabled) || val.disabled === 'true' || val.disabled === 1
      }))
    }));
  }

  private generateCombinations(
    properties: SkuProperty[],
    skuMap?: any
  ): SkuCombination[] {
    const combinations: SkuCombination[] = [];

    const generate = (
      currentIndex: number,
      currentSelections: Array<{
        propId: string;
        propName: string;
        valueId: string;
        valueName: string;
      }>
    ) => {
      if (currentIndex >= properties.length) {
        const skuKey = currentSelections.map(s => `${s.propId}:${s.valueId}`).join(';');
        const propertiesStr = currentSelections.map(s => `${s.propName}:${s.valueName}`).join(';');

        const skuInfo = skuMap ? this.findSkuInfo(skuKey, skuMap) : null;

        combinations.push({
          skuId: skuInfo?.skuId || skuKey,
          skuKey,
          properties: propertiesStr,
          selections: [...currentSelections],
          price: skuInfo?.price,
          originalPrice: skuInfo?.originalPrice,
          stock: skuInfo?.stock ?? 999,
          imageUrl: currentSelections[0]?.valueName ?
            properties[0].values.find(v => v.valueId === currentSelections[0].valueId)?.imageUrl :
            undefined
        });
        return;
      }

      const prop = properties[currentIndex];
      for (const value of prop.values) {
        if (value.disabled) continue;
        generate(currentIndex + 1, [
          ...currentSelections,
          {
            propId: prop.propId,
            propName: prop.propName,
            valueId: value.valueId,
            valueName: value.valueName
          }
        ]);
      }
    };

    generate(0, []);
    return combinations;
  }

  private findSkuInfo(skuKey: string, skuMap: any): any {
    if (!skuMap) return null;

    const normalizedKey = skuKey.replace(/:/g, ';').replace(/,/g, ';');

    for (const [key, value] of Object.entries(skuMap)) {
      const normalizedMapKey = key.replace(/:/g, ';').replace(/,/g, ';');
      if (normalizedMapKey === normalizedKey) {
        return value;
      }
    }

    return null;
  }

  private async createSingleSkuTree(taobaoId: string): Promise<SkuTree> {
    const priceText = await this.page.locator('.price, .final-price, [class*="Price"]')
      .first()
      .textContent()
      .catch(() => null);

    const price = priceText ? parseFloat(priceText.match(/[\d.]+/)?.[0] || '0') : undefined;

    return {
      properties: [],
      combinations: [{
        skuId: taobaoId,
        skuKey: 'default',
        properties: '默认',
        selections: [],
        price,
        stock: 999
      }],
      totalCount: 1
    };
  }

  async getAvailableSkuSelectors(skuId: string): Promise<string[]> {
    const selectors = await this.page.evaluate((id) => {
      const vids = id.split(';').map(part => part.split(':')[1]);
      return vids.map(vid => `[data-vid="${vid}"], [data-value="${vid}"]`);
    }, skuId);

    return selectors;
  }
}
