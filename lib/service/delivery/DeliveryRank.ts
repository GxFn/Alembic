/** CursorDeliveryPipeline ordering weights. */
export const DELIVERY_RANK = Object.freeze({
  CONFIDENCE_WEIGHT: 50,
  AUTHORITY_WEIGHT: 30,
  USE_COUNT_MAX: 10,
  USE_COUNT_WEIGHT: 2,
  ACTIVE_BONUS: 10,
});
