export const validate = (schema) => {
  return (req, res, next) => {
    try {
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request payload validation failed',
            details: parsed.error.format()
          }
        });
      }
      req.validatedBody = parsed.data;
      next();
    } catch (err) {
      next(err);
    }
  };
};

