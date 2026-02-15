import { clsx } from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  className?: string;
  hover?: boolean;
}

interface CardSubProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  className?: string;
}

function CardComponent({ children, className, hover, ...props }: CardProps): JSX.Element {
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

function CardHeader({ children, className, ...props }: CardSubProps): JSX.Element {
  return (
    <div
      className={clsx('px-4 py-3 border-b border-border-default', className)}
      {...props}
    >
      {children}
    </div>
  );
}

function CardBody({ children, className, ...props }: CardSubProps): JSX.Element {
  return (
    <div className={clsx('px-4 py-4', className)} {...props}>
      {children}
    </div>
  );
}

function CardFooter({ children, className, ...props }: CardSubProps): JSX.Element {
  return (
    <div
      className={clsx('px-4 py-3 border-t border-border-default bg-bg-tertiary/50', className)}
      {...props}
    >
      {children}
    </div>
  );
}

const Card = Object.assign(CardComponent, {
  Header: CardHeader,
  Body: CardBody,
  Footer: CardFooter,
});

export default Card;
