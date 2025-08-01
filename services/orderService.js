const prisma = require("../config/db");

const { createTransaction } = require("./transactionService");
const userService = require("./userService");

const submitCart = async (userId, mobileNumber = null) => {
  // Use a transaction to ensure atomicity
  return await prisma.$transaction(async (tx) => {
    const cart = await tx.cart.findUnique({
      where: { userId },
      include: {
        items: { include: { product: true } },
      },
    });

    if (!cart || cart.items.length === 0) {
      throw new Error("Cart is empty");
    }

    // Calculate total order price
    const totalPrice = cart.items.reduce((sum, item) => sum + item.product.price * item.quantity, 0);

    // Get user current balance
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new Error("User not found");
    }

    if (user.loanBalance < totalPrice) {
      throw new Error("Insufficient balance to place order");
    }

    // Set mobile number if provided
    if (mobileNumber && !cart.mobileNumber) {
      await tx.cart.update({
        where: { id: cart.id },
        data: { mobileNumber },
      });
    }

    // Create order
    const order = await tx.order.create({
      data: {
        userId,
        mobileNumber: cart.mobileNumber || mobileNumber,
        items: {
          create: cart.items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            mobileNumber: item.mobileNumber,
            status: "Pending",
          })),
        },
      },
      include: { items: { include: { product: true } } },
    });

    // Record transaction for the order
    // createTransaction must use the transaction-bound prisma
    await createTransaction(
      userId,
      -totalPrice, // Negative amount for deduction
      "ORDER",
      `Order #${order.id} placed with ${order.items.length} items`,
      `order:${order.id}`,
      tx // pass the transaction-bound prisma
    );

    // Clear cart (we already have the items in the order)
    await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

    return order;
  });
};

async function getAllOrders() {
  return await prisma.order.findMany({
    orderBy: {
      createdAt: "desc",
    },
    include: {
      user: {
        // Include user details --- just to remember - Godfrey
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
        },
      },
      items: {
        include: {
          product: {
            // Include product details --- just to remember - Godfrey
            select: {
              id: true,
              name: true,
              description: true,
              price: true,
            },
          },
        },
      },
    },
  });
}

// Admin: Process and complete an order
const processOrder = async (orderId, status) => {
  const validStatuses = ["Pending", "Processing", "Completed"];
  if (!validStatuses.includes(status)) {
    throw new Error("Invalid order status");
  }

  const order = await prisma.order.update({
    where: { id: orderId },
    data: { status },
    include: {
      user: true,
      items: { include: { product: true } }
    }
  });

  // Record transaction for status change
  await createTransaction(
    order.userId,
    0, // Zero amount for status change
    "ORDER_STATUS",
    `Order #${orderId} status changed to ${status}`,
    `order:${orderId}`
  );

  return order;
};

const processOrderItem = async (orderItemId, status) => {
  const validStatuses = ["Pending", "Processing", "Completed", "Cancelled", "Canceled"];
  if (!validStatuses.includes(status)) {
    throw new Error("Invalid order status");
  }
  const orderItem = await prisma.orderItem.update({
    where: { id: orderItemId },
    data: { status },
    include: { order: true, product: true }
  });

  // Auto-refund logic for cancelled/canceled
  if (["Cancelled", "Canceled"].includes(status)) {
    const refundAmount = orderItem.product.price * orderItem.quantity;
    const existingRefund = await prisma.transaction.findFirst({
      where: {
        userId: orderItem.order.userId,
        type: "ORDER_ITEM_REFUND",
        reference: `orderItem:${orderItemId}`
      }
    });
    if (!existingRefund) {
      // Refund user wallet and log transaction
      await createTransaction(
        orderItem.order.userId,
        refundAmount,
        "ORDER_ITEM_REFUND",
        `Order item #${orderItemId} (${orderItem.product.name}) refunded`,
        `orderItem:${orderItemId}`
      );
    }
  }

  await createTransaction(
    orderItem.order.userId,
    0,
    "ORDER_ITEM_STATUS",
    `Order item #${orderItemId} (${orderItem.product.name}) status changed to ${status}`,
    `orderItem:${orderItemId}`
  );
  return orderItem;
};

// ... (rest of the code remains the same)

const getOrderStatus = async () => {
  return await prisma.order.findMany({
    include: {
      items: {
        include: {
          product: true
        }
      },
      user: {
        select: { id: true, name: true, email: true }
      }
    }
  });
};

const getOrderHistory = async (userId) => {
  return await prisma.order.findMany({
    where: { userId },
    include: {
      items: {
        include: { product: true }
      }
    },
    orderBy: { createdAt: "desc" }
  });
};

const getUserCompletedOrders = async (userId) => {
  return await prisma.order.findMany({
    where: { userId, status: "Completed" },
    include: {
      items: {
        include: {
          product: true
        }
      }
    },
    orderBy: { createdAt: "desc" }
  });
};

const updateOrderItemsStatus = async (orderId, newStatus) => {
  try {
    const order = await prisma.order.findUnique({ 
      where: { id: parseInt(orderId) }, 
      select: { userId: true } 
    });
    
    if (!order) {
      throw new Error("Order not found");
    }
    
    // If status is cancelled/canceled, handle refund logic
    if (["Cancelled", "Canceled"].includes(newStatus)) {
      const refundReference = `order_items_refund:${orderId}`;
      
      const existingRefund = await prisma.transaction.findFirst({
        where: {
          userId: order.userId,
          type: "ORDER_ITEMS_REFUND",
          reference: refundReference
        }
      });
      
      if (!existingRefund) {
        // Calculate total order amount
        const items = await prisma.orderItem.findMany({
          where: { orderId: parseInt(orderId) },
          include: { product: true }
        });
        
        let totalOrderAmount = 0;
        for (const item of items) {
          totalOrderAmount += item.product.price * item.quantity;
        }
        
        // Find the original order transaction to get the amount that was deducted
        const originalOrderTransaction = await prisma.transaction.findFirst({
          where: {
            userId: order.userId,
            type: "ORDER",
            reference: `order:${orderId}`,
            amount: { lt: 0 } // Negative amount (deduction)
          }
        });
        
        let refundAmount = totalOrderAmount;
        
        if (originalOrderTransaction) {
          refundAmount = Math.abs(originalOrderTransaction.amount);
        }
        
        if (refundAmount > 0) {
          // Process the refund
          await createTransaction(
            order.userId,
            refundAmount,
            "ORDER_ITEMS_REFUND",
            `All items in order #${orderId} refunded (Amount: ${refundAmount})`,
            refundReference
          );
        }
      } else {
        console.log(`Refund already processed for order ${orderId}. Skipping duplicate refund.`);
      }
    }
    
    // Update order items status
    const updatedItems = await prisma.orderItem.updateMany({ 
      where: { orderId: parseInt(orderId) }, 
      data: { status: newStatus } 
    });
    
    // Create status change transaction (only if not a duplicate)
    const statusChangeReference = `order_status:${orderId}:${newStatus}`;
    const existingStatusChange = await prisma.transaction.findFirst({
      where: {
        userId: order.userId,
        type: "ORDER_ITEMS_STATUS",
        reference: statusChangeReference
      }
    });
    
    if (!existingStatusChange) {
      await createTransaction(
        order.userId, 
        0, 
        "ORDER_ITEMS_STATUS", 
        `All items in order #${orderId} status changed to ${newStatus}`, 
        statusChangeReference
      );
    }
    
    return { 
      success: true, 
      updatedCount: updatedItems.count, 
      message: `Successfully updated ${updatedItems.count} order items to ${newStatus}` 
    };
  } catch (error) {
    console.error("Error updating order items status:", error);
    throw new Error("Failed to update order items status");
  }
};

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Exporting functions for use in controllers
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

const orderService = {
  async getOrdersPaginated({ page = 1, limit = 20, filters = {} }) {
    const { startDate, endDate, status, product, mobileNumber } = filters;
    
    // Build where clause
    const where = {};
    
    if (startDate && endDate) {
      where.createdAt = {
        gte: new Date(startDate),
        lte: new Date(endDate),
      };
    }
    
    if (status) {
      where.items = {
        some: {
          status,
        },
      };
    }
    
    if (product) {
      where.items = {
        ...(where.items || {}),
        some: {
          ...(where.items?.some || {}),
          product: {
            name: product,
          },
        },
      };
    }
    
    if (mobileNumber) {
      where.mobileNumber = {
        contains: mobileNumber,
      };
    }
    
    // Calculate pagination parameters
    const skip = (page - 1) * parseInt(limit);
    
    // Get count for pagination info
    const totalOrders = await prisma.order.count({ where });
    
    // Get paginated orders
    const orders = await prisma.order.findMany({
      where,
      skip,
      take: parseInt(limit),
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                price: true,
                description: true,
              },
            },
          },
        },
        user: {
          select: { 
            id: true, 
            name: true, 
            email: true, 
            phone: true 
          },
        },
      },
    });
    
    // Transform data for frontend efficiency
    // This eliminates the need for frontend data processing
    const transformedItems = orders.flatMap(order => 
      order.items.map(item => ({
        id: item.id,
        orderId: order.id,
        mobileNumber: order.mobileNumber,
        user: order.user,
        createdAt: order.createdAt,
        product: item.product,
        status: item.status,
        order: {
          id: order.id,
          createdAt: order.createdAt,
          items: [{ status: item.status }] // Only include what's needed
        }
      }))
    );
    
    return {
      items: transformedItems,
      pagination: {
        total: totalOrders,
        pages: Math.ceil(totalOrders / parseInt(limit)),
        currentPage: parseInt(page),
        limit: parseInt(limit)
      }
    };
  },
  
  async getOrderStats() {
    // Get just the counts for dashboard stats
    const totalOrders = await prisma.order.count();
    
    const pendingCount = await prisma.order.count({
      where: {
        items: {
          some: {
            status: 'Pending'
          }
        }
      }
    });
    
    const completedCount = await prisma.order.count({
      where: {
        items: {
          some: {
            status: 'Completed'
          }
        }
      }
    });
    
    const processingCount = await prisma.order.count({
      where: {
        items: {
          some: {
            status: 'Processing'
          }
        }
      }
    });
    
    return {
      total: totalOrders,
      pending: pendingCount,
      completed: completedCount,
      processing: processingCount
    };
  },
  
  async updateOrderStatus(orderId, status) {
    return await prisma.order.update({
      where: { id: orderId },
      data: {
        items: {
          updateMany: {
            where: {},
            data: { status }
          }
        }
      }
    });
  }
};

module.exports = {
  submitCart,
  getAllOrders,
  processOrder,
  getUserCompletedOrders,
  processOrderItem,
  getOrderStatus,
  getOrderHistory,
  updateOrderItemsStatus,

  orderService
};