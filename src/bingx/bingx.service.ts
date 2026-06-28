import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class BingxService {
  private readonly apiKey = process.env.BINGX_API_KEY as string;
  private readonly apiSecret = process.env.BINGX_API_SECRET as string;
  private readonly baseUrl = process.env.BINGX_BASE_URL as string;

  private sign(queryString: string): string {
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');
  }

private buildQueryString(params: Record<string, string | number>): string {
    const allParams = { ...params, timestamp: Date.now() };
    const sortedKeys = Object.keys(allParams).sort();
    return sortedKeys.map((key) => `${key}=${allParams[key]}`).join('&');
  }

async getOpenOrders(symbol?: string) {
    const params: Record<string, string | number> = {};
    if (symbol) {
      params.symbol = symbol;
    }
    const query = this.buildQueryString(params);
    const signature = this.sign(query);
    const url = `${this.baseUrl}/openApi/swap/v2/trade/openOrders?${query}&signature=${signature}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'X-BX-APIKEY': this.apiKey },
    });

    return response.json();
  }


async placeStopOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    positionSide: 'LONG' | 'SHORT',
    type: 'TAKE_PROFIT_MARKET' | 'STOP_MARKET',
    stopPrice: number,
    quantity: number,
  ) {
    const query = this.buildQueryString({
      symbol,
      side,
      positionSide,
      type,
      stopPrice,
      quantity,
      workingType: 'MARK_PRICE',
    });
    const signature = this.sign(query);
    const url = `${this.baseUrl}/openApi/swap/v2/trade/order?${query}&signature=${signature}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'X-BX-APIKEY': this.apiKey },
    });

    return response.json();
  }

  async getPositions(symbol?: string) {
    const params: Record<string, string | number> = {};
    if (symbol) {
      params.symbol = symbol;
    }
    const query = this.buildQueryString(params);
    const signature = this.sign(query);
    const url = `${this.baseUrl}/openApi/swap/v2/user/positions?${query}&signature=${signature}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'X-BX-APIKEY': this.apiKey },
    });

    return response.json();
  }


async cancelOrder(symbol: string, orderId: string) {
    const query = this.buildQueryString({ symbol, orderId });
    const signature = this.sign(query);
    const url = `${this.baseUrl}/openApi/swap/v2/trade/order?${query}&signature=${signature}`;

    const response = await fetch(url, {
      method: 'DELETE',
      headers: { 'X-BX-APIKEY': this.apiKey },
    });

    return response.json();
  }

async queryOrder(symbol: string, orderId: string) {
    const query = this.buildQueryString({ symbol, orderId });
    const signature = this.sign(query);
    const url = `${this.baseUrl}/openApi/swap/v2/trade/order?${query}&signature=${signature}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'X-BX-APIKEY': this.apiKey },
    });

    return response.json();
  }

async placeOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    positionSide: 'LONG' | 'SHORT',
    price: number,
    quantity: number,
  ) {
    const query = this.buildQueryString({
      symbol,
      side,
      positionSide,
      type: 'LIMIT',
      price,
      quantity,
      timeInForce: 'GTC',
    });
    const signature = this.sign(query);
    const url = `${this.baseUrl}/openApi/swap/v2/trade/order?${query}&signature=${signature}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'X-BX-APIKEY': this.apiKey },
    });

    return response.json();
  }

async getLeverage(symbol: string) {
    const query = this.buildQueryString({ symbol });
    const signature = this.sign(query);
    const url = `${this.baseUrl}/openApi/swap/v2/trade/leverage?${query}&signature=${signature}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'X-BX-APIKEY': this.apiKey },
    });

    return response.json();
  }

async setLeverage(
    symbol: string,
    side: 'LONG' | 'SHORT' | 'BOTH',
    leverage: number,
  ) {
    const query = this.buildQueryString({ symbol, side, leverage });
    const signature = this.sign(query);
    const url = `${this.baseUrl}/openApi/swap/v2/trade/leverage?${query}&signature=${signature}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'X-BX-APIKEY': this.apiKey },
    });

    return response.json();
  }

async getContractInfo(symbol: string) {
    const query = this.buildQueryString({ symbol });
    const signature = this.sign(query);
    const url = `${this.baseUrl}/openApi/swap/v2/quote/contracts?${query}&signature=${signature}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'X-BX-APIKEY': this.apiKey },
    });

    return response.json();
  }

async testOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    positionSide: 'LONG' | 'SHORT',
    price: number,
    quantity: number,
  ) {
    const query = this.buildQueryString({
      symbol,
      side,
      positionSide,
      type: 'LIMIT',
      price,
      quantity,
      timeInForce: 'GTC',
    });
    const signature = this.sign(query);
    const url = `${this.baseUrl}/openApi/swap/v2/trade/order/test?${query}&signature=${signature}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'X-BX-APIKEY': this.apiKey },
    });

    return response.json();
  }



async getPositionMode() {
    const query = this.buildQueryString({});
    const signature = this.sign(query);
    const url = `${this.baseUrl}/openApi/swap/v1/positionSide/dual?${query}&signature=${signature}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'X-BX-APIKEY': this.apiKey },
    });

    return response.json();
  }

  async getPrice(symbol: string) {
    const query = this.buildQueryString({ symbol });
    const signature = this.sign(query);
    const url = `${this.baseUrl}/openApi/swap/v1/ticker/price?${query}&signature=${signature}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'X-BX-APIKEY': this.apiKey },
    });

    return response.json();
  }

async getBalance() {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = this.sign(queryString);

    const url = `${this.baseUrl}/openApi/swap/v3/user/balance?${queryString}&signature=${signature}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-BX-APIKEY': this.apiKey,
      },
    });

    return response.json();
  }
}