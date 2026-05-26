// modules/prompts/prompts.service.ts
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../prisma/redis.service';
import { ConfigService } from '@nestjs/config';
import { MediaService } from '../media/media.service';
import * as CryptoJS from 'crypto-js';
import { SubscriptionStatus } from '../../common/types/subscription';

@Injectable()
export class PromptsService {
  private readonly logger = new Logger(PromptsService.name);
  private encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
    private readonly mediaService: MediaService,
  ) {
    this.encryptionKey = this.configService.get('encryption.key');
  }

  async findAll(filters: {
    category?: string;
    search?: string;
    limit?: number;
    page?: number;
    userId?: string;
    includePurchased?: boolean;
  }) {
    const {
      category,
      search,
      limit = 20,
      page = 1,
      userId,
      includePurchased = false,
    } = filters;

    console.log('🔍 [PROMPTS SERVICE] findAll called with:', {
      userId,
      includePurchased,
      category,
      search,
      page,
      limit,
    });

    const skip = (page - 1) * limit;

    const where: any = { isActive: true };

    if (category && category !== 'ALL') where.category = category;
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    // Get user's purchased prompt IDs if userId is provided
    let purchasedPromptIds: string[] = [];
    if (userId && !includePurchased) {
      // Only filter if NOT including purchased
      console.log(
        '🔍 [PROMPTS SERVICE] Filtering out purchased prompts for user:',
        userId,
      );

      const purchases = (await this.prisma.purchase.findMany({
        where: {
          userId,
          status: 'COMPLETED',
        },
        select: { promptId: true },
      })) as any;

      purchasedPromptIds = purchases.map((p) => p.promptId);
      console.log(
        '🔍 [PROMPTS SERVICE] Purchased prompt IDs:',
        purchasedPromptIds,
      );

      // EXCLUDE purchased prompts from the results
      if (purchasedPromptIds.length > 0) {
        where.NOT = {
          id: { in: purchasedPromptIds },
        };
        console.log(
          '🔍 [PROMPTS SERVICE] Added NOT filter for purchased prompts',
        );
      }
    } else {
      console.log('🔍 [PROMPTS SERVICE] Not filtering purchased prompts:', {
        hasUserId: !!userId,
        includePurchased,
      });
    }

    // Get prompts
    const [prompts, total] = await Promise.all([
      this.prisma.prompt.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          slug: true,
          description: true,
          category: true,
          previewContent: true,
          fullContent: true, // Need this for decryption
          priceStars: true,
          priceTon: true,
          priceLocal: true,
          purchaseCount: true,
          rating: true,
          imageUrl: true,
          imageAlt: true,
          isPremium: true,
          isActive: true,
          creatorId: true,
          createdAt: true,
          updatedAt: true,
          creator: {
            select: {
              id: true,
              username: true,
              firstName: true,
            },
          },
        },
      }),
      this.prisma.prompt.count({ where }),
    ]);

    // Get purchase status and subscription status for the user
    let userPurchaseStatus: Record<string, string> = {};
    let isSubscriber = false;

    if (userId) {
      const [userPurchases, user] = await Promise.all([
        this.prisma.purchase.findMany({
          where: {
            userId,
            promptId: { in: prompts.map((p: any) => p.id) },
          },
          select: { promptId: true, status: true },
        }),
        this.prisma.user.findUnique({
          where: { id: userId },
          select: { subscriptionStatus: true },
        }),
      ]);

      userPurchaseStatus = (userPurchases as any).reduce(
        (acc: Record<string, string>, purchase: any) => {
          acc[purchase.promptId] = purchase.status;
          return acc;
        },
        {},
      );

      isSubscriber = (user as any)?.subscriptionStatus === 'ACTIVE';
    }

    const encryptionKey = process.env.ENCRYPTION_KEY;

    const data = prompts.map((prompt: any) => {
      const isCreator = userId && prompt.creator?.id === userId;
      const isPurchased =
        userPurchaseStatus[prompt.id] === 'COMPLETED' ||
        purchasedPromptIds.includes(prompt.id);
      const isFree = prompt.priceStars === 0;
      const hasAccess = isPurchased || isFree || isSubscriber || isCreator;

      let decryptedContent = null;

      if (hasAccess && prompt.fullContent) {
        // Attempt to decrypt if it's premium, otherwise it's plain text
        if (prompt.priceStars > 0 && encryptionKey) {
          try {
            const bytes = CryptoJS.AES.decrypt(
              prompt.fullContent,
              encryptionKey,
            );
            const decrypted = bytes.toString(CryptoJS.enc.Utf8);
            if (decrypted) {
              decryptedContent = decrypted;
            } else {
              decryptedContent = prompt.fullContent; // Fallback
            }
          } catch (e) {
            decryptedContent = prompt.fullContent; // It might be plain text or corrupt
          }
        } else {
          decryptedContent = prompt.fullContent;
        }
      }

      // Strip sensitive fields
      const { fullContent, previewContent, ...rest } = prompt;

      return {
        ...rest,
        hasAccess,
        decryptedContent,
        purchaseStatus: userPurchaseStatus[prompt.id] || null,
      };
    });

    return {
      success: true,
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: string, userId?: string) {
    try {
      const prompt = await this.prisma.prompt.findFirst({
        where: {
          id,
          OR: [
            { isActive: true },
            userId ? { creatorId: userId } : {}
          ]
        },
        select: {
          id: true,
          slug: true,
          title: true,
          description: true,
          category: true,
          previewContent: true,
          priceStars: true,
          priceTon: true,
          priceLocal: true,
          purchaseCount: true,
          rating: true,
          imageUrl: true,
          imageAlt: true,
          isPremium: true,
          isActive: true,
          creatorId: true,
          createdAt: true,
          updatedAt: true,
          fullContent: true,
          creator: {
            select: {
              id: true,
              username: true,
              firstName: true,
            },
          },
        },
      });

      if (!prompt) {
        throw new NotFoundException('Prompt not found');
      }

      let hasAccess = false;
      if (prompt.priceStars === 0 || (userId && prompt.creatorId === userId)) {
        hasAccess = true;
      } else if (userId) {
        hasAccess = await this.checkUserAccess(userId, id);
      }

      const { fullContent, ...rest } = prompt;
      let decryptedContent = undefined;

      if (hasAccess && fullContent) {
        if (prompt.priceStars > 0 && this.encryptionKey) {
          try {
            const bytes = CryptoJS.AES.decrypt(fullContent, this.encryptionKey);
            const decrypted = bytes.toString(CryptoJS.enc.Utf8);
            if (decrypted) {
              decryptedContent = decrypted;
            }
          } catch (e) {
            // Fallback if decryption fails
          }
        } else {
          decryptedContent = fullContent;
        }
      }

      return {
        success: true,
        data: {
          ...rest,
          hasAccess,
          decryptedContent,
        },
      };
    } catch (error) {
      this.logger.error(`Failed to fetch prompt ${id}`, error);
      throw error;
    }
  }

  async getFullPrompt(userId: string, promptId: string) {
    // Get prompt first to check if it's free or if the user is the creator
    const prompt = await this.prisma.prompt.findUnique({
      where: { id: promptId },
      select: { fullContent: true, priceStars: true, creatorId: true },
    });

    if (!prompt) {
      throw new NotFoundException('Prompt not found');
    }

    const isFree = prompt.priceStars === 0;
    const isCreator = prompt.creatorId === userId;

    if (!isFree && !isCreator) {
      // Check cache first for paid prompts
      const cacheKey = `user:${userId}:access:${promptId}`;
      const cachedAccess = await this.redis.get(cacheKey);

      if (cachedAccess !== 'true') {
        let hasAccess = false;
        // Check for active subscription
        const user = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { subscriptionStatus: true } as any,
        });

        if ((user as any)?.subscriptionStatus === 'ACTIVE') {
          // Subscribers get access!
          hasAccess = true;
        } else {
          // Check database for individual purchase
          const purchase = await this.prisma.purchase.findFirst({
            where: {
              userId,
              promptId,
              status: 'COMPLETED',
            },
          });
          hasAccess = !!purchase;
        }

        if (!hasAccess) {
          throw new ForbiddenException('Subscription or Purchase required');
        }

        // Cache access for 24 hours
        await this.redis.set(cacheKey, 'true', 60 * 60 * 24);
      }
    }

    // Decrypt content if premium
    let finalContent = prompt.fullContent;
    
    if (!isFree && this.encryptionKey && prompt.fullContent) {
      try {
        const bytes = CryptoJS.AES.decrypt(
          prompt.fullContent,
          this.encryptionKey,
        );
        const decrypted = bytes.toString(CryptoJS.enc.Utf8);
        if (decrypted) {
          finalContent = decrypted;
        }
      } catch (e) {
        // Fallback to plain text if decryption fails
      }
    }

    // Log access
    await this.redis.zincrby(
      `prompt:${promptId}:access`,
      1,
      Date.now().toString(),
    );

    return {
      success: true,
      data: {
        content: finalContent,
      },
    };
  }

  private async checkUserAccess(
    userId: string,
    promptId: string,
  ): Promise<boolean> {
    const cacheKey = `user:${userId}:access:${promptId}`;

    // Check cache
    const cached = await this.redis.get(cacheKey);
    if (cached === 'true') return true;
    if (cached === 'false') return false;

    // 1. Check for individual purchase
    const purchase = await this.prisma.purchase.findFirst({
      where: {
        userId,
        promptId,
        status: 'COMPLETED',
      },
    });

    if (purchase) {
      await this.redis.set(cacheKey, 'true', 60 * 60 * 24);
      return true;
    }

    // 2. Check for active subscription and credits
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        subscriptionStatus: true,
        categoryCredits: true,
      } as any,
    });

    if ((user as any)?.subscriptionStatus === SubscriptionStatus.ACTIVE) {
      // Get the prompt's category
      const prompt = await this.prisma.prompt.findUnique({
        where: { id: promptId },
        select: { category: true },
      });

      if (prompt) {
        const credits = (user as any).categoryCredits || {};
        const category = prompt.category;

        // Check if user has credits for this category
        if (credits[category] > 0) {
          // Deduct one credit
          const newCredits = { ...credits };
          newCredits[category] -= 1;

          await this.prisma.user.update({
            where: { id: userId },
            data: { categoryCredits: newCredits } as any,
          });

          this.logger.log(
            `User ${userId} used 1 ${category} credit for prompt ${promptId}. Remaining: ${newCredits[category]}`,
          );

          await this.redis.set(cacheKey, 'true', 60 * 60 * 24);
          return true;
        }
      }
    }

    // No access
    await this.redis.set(cacheKey, 'false', 60 * 60 * 24);
    return false;
  }

  async getCategories() {
    try {
      // Simple approach: get distinct categories from prompts
      const prompts = await this.prisma.prompt.findMany({
        where: { isActive: true },
        distinct: ['category'],
        select: { category: true },
      });

      // Get count for each category
      const categoriesWithCount = await Promise.all(
        prompts.map(async (prompt) => {
          const count = await this.prisma.prompt.count({
            where: {
              category: prompt.category,
              isActive: true,
            },
          });
          return {
            name: prompt.category,
            count,
          };
        }),
      );

      return {
        success: true,
        data: categoriesWithCount,
      };
    } catch (error) {
      this.logger.error('Failed to fetch categories', error);
      return {
        success: true,
        data: [],
      };
    }
  }

  async findPurchased(
    userId: string,
    filters: {
      category?: string;
      search?: string;
      limit?: number;
      page?: number;
    },
  ) {
    const { category, search, limit = 20, page = 1 } = filters;
    const skip = (page - 1) * limit;

    // Get user's purchased prompt IDs
    const purchases = await this.prisma.purchase.findMany({
      where: {
        userId,
        status: 'COMPLETED',
      },
      select: {
        promptId: true,
        status: true,
        unlockedAt: true,
        createdAt: true,
      },
    });

    const purchasedPromptIds = purchases.map((p) => p.promptId);

    if (purchasedPromptIds.length === 0) {
      return {
        success: true,
        data: [],
        meta: {
          total: 0,
          page,
          limit,
          totalPages: 0,
        },
      };
    }

    const where: any = {
      id: { in: purchasedPromptIds },
      isActive: true,
    };

    if (category && category !== 'ALL') where.category = category;
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [prompts, total] = await Promise.all([
      this.prisma.prompt.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          slug: true,
          description: true,
          category: true,
          previewContent: true,
          fullContent: true, // Need this for decryption
          priceStars: true,
          priceTon: true,
          priceLocal: true,
          purchaseCount: true,
          rating: true,
          imageUrl: true,
          imageAlt: true,
          createdAt: true,
          updatedAt: true,
          creator: {
            select: {
              id: true,
              username: true,
              firstName: true,
            },
          },
        },
      }),
      this.prisma.prompt.count({ where }),
    ]);

    // Create purchase status map
    const purchaseMap = new Map(
      purchases.map((p) => [
        p.promptId,
        {
          status: p.status,
          unlockedAt: p.unlockedAt,
          purchasedAt: p.createdAt,
        },
      ]),
    );

    const encryptionKey = process.env.ENCRYPTION_KEY;

    const data = prompts.map((prompt: any) => {
      let decryptedContent = null;

      if (prompt.fullContent) {
        if (prompt.priceStars > 0 && encryptionKey) {
          try {
            const bytes = CryptoJS.AES.decrypt(
              prompt.fullContent,
              encryptionKey,
            );
            const decrypted = bytes.toString(CryptoJS.enc.Utf8);
            if (decrypted) {
              decryptedContent = decrypted;
            } else {
              decryptedContent = prompt.fullContent;
            }
          } catch (e) {
            decryptedContent = prompt.fullContent;
          }
        } else {
          decryptedContent = prompt.fullContent;
        }
      }

      // Strip sensitive fields
      const { fullContent, previewContent, ...rest } = prompt;

      return {
        ...rest,
        hasAccess: true,
        decryptedContent,
        purchaseStatus: purchaseMap.get(prompt.id)?.status || 'COMPLETED',
        unlockedAt: purchaseMap.get(prompt.id)?.unlockedAt,
        purchasedAt: purchaseMap.get(prompt.id)?.purchasedAt,
      };
    });

    return {
      success: true,
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findCreated(userId: string) {
    const prompts = await this.prisma.prompt.findMany({
      where: { creatorId: userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        slug: true,
        description: true,
        category: true,
        priceStars: true,
        imageUrl: true,
        isActive: true,
        createdAt: true,
        purchaseCount: true,
        purchases: {
          where: { status: 'COMPLETED' },
          select: {
            paymentMethod: true,
            amountPaid: true,
            currency: true,
          },
        },
      },
    });

    return {
      success: true,
      data: prompts,
    };
  }

  async submitPrompt(data: {
    title: string;
    description: string;
    category: string;
    priceStars: number | string;
    previewContent: string;
    fullContent: string;
    creatorId: string;
    priceTon?: number | string;
    priceLocal?: number | string;
    imageFile?: Express.Multer.File;
  }) {
    // 1. Validate required fields
    const requiredFields = [
      'title',
      'description',
      'category',
      'priceStars',
      'fullContent',
    ];
    for (const field of requiredFields) {
      if (!data[field as keyof typeof data]) {
        throw new BadRequestException(`Field "${field}" is required`);
      }
    }

    // 2. Parse numbers
    const parseNumber = (val: string | number) => {
      const parsed = typeof val === 'string' ? parseFloat(val) : val;
      if (isNaN(parsed)) throw new BadRequestException(`Invalid number`);
      return parsed;
    };
    
    const priceStars = parseNumber(data.priceStars);
    const priceTon = data.priceTon ? parseNumber(data.priceTon) : 0;
    const priceLocal = data.priceLocal ? parseNumber(data.priceLocal) : 0;

    // 3. Generate slug
    const generateSlug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    let slug = generateSlug(data.title);

    // Ensure slug uniqueness
    const existing = await this.prisma.prompt.findUnique({ where: { slug } });
    if (existing) {
      slug = `${slug}-${Date.now().toString().slice(-4)}`;
    }

    // 4. Encrypt content
    let encryptedContent = data.fullContent;
    if (priceStars > 0 && this.encryptionKey) {
      encryptedContent = CryptoJS.AES.encrypt(
        data.fullContent,
        this.encryptionKey,
      ).toString();
    }

    // 5. Handle image upload
    let imageUrl: string | null = null;
    if (data.imageFile) {
      const uploadResult = await this.mediaService.uploadFile(data.imageFile);
      imageUrl = uploadResult.url;
    }

    // 6. Create prompt in DB with isActive = false
    const prompt = await this.prisma.prompt.create({
      data: {
        title: data.title,
        slug,
        description: data.description,
        category: data.category,
        priceStars,
        priceTon,
        priceLocal,
        previewContent: data.previewContent || '',
        fullContent: encryptedContent,
        creatorId: data.creatorId,
        imageUrl,
        imageAlt: data.title,
        isActive: false, // Critical: Pending review
      },
    });

    return {
      success: true,
      message: 'Prompt submitted for review',
      data: { id: prompt.id, slug: prompt.slug },
    };
  }
}
