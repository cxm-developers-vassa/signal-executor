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