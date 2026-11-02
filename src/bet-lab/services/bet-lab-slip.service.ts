import { Injectable } from '@nestjs/common';
import { PlaceBetLabSlipDto } from '../dto/place-bet-lab-slip.dto';
import { BetLabTicketService } from './bet-lab-ticket.service';

/** Slip placement is deliberately separated from single-ticket placement at the API boundary. */
@Injectable()
export class BetLabSlipService {
  constructor(private readonly ticketService: BetLabTicketService) {}

  place(userId: string, dto: PlaceBetLabSlipDto) {
    return this.ticketService.placeSlip(userId, dto);
  }
}
