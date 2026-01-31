import { clsx } from 'clsx';

export default function Card({ children, className, hover, ...props }) {
  return (
    <div
      className={clsx(
        'bg-bg-secondary border border-border-default rounded-md',
        hover && 'hover:border-border-default/80 transition-colors cursor-pointer',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

Card.Header = function CardHeader({ children, className, ...props }) {
  return (
    <div
      className={clsx('px-4 py-3 border-b border-border-default', className)}
      {...props}
    >
      {children}
    </div>
  );
};

Card.Body = function CardBody({ children, className, ...props }) {
  return (
    <div className={clsx('px-4 py-4', className)} {...props}>
      {children}
    </div>
  );
};

Card.Footer = function CardFooter({ children, className, ...props }) {
  return (
    <div
      className={clsx('px-4 py-3 border-t border-border-default bg-bg-tertiary/50', className)}
      {...props}
    >
      {children}
    </div>
  );
};
