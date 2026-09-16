import { FastifyRequest, FastifyReply } from "fastify";
import { CustomerService } from "./customers.service.js";
import { CustomerFilters } from "./customers.types.js";

const customerService = new CustomerService();

export class CustomerController {

async getAllCustomers(request: FastifyRequest, reply: FastifyReply) {
  try {
    const { page, limit } = request.query as {
      page?: string;
      limit?: string;
    };

    const customers = await customerService.getAllCustomers({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });

    return reply.code(200).send({
      success: true,
      data: customers,
    });
  } catch (error: any) {
    return reply.code(500).send({
      success: false,
      error: error.message,
    });
  }
}
}