// Validates req[source] against a zod schema and stores the parsed (typed, trimmed,
// converted) result in req.valid[source]. Handlers only ever read req.valid,
// never the raw request.
export function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const parsed = schema.parse(req[source]); // ZodError -> 400 in errorHandler
    req.valid = { ...req.valid, [source]: parsed };
    next();
  };
}
